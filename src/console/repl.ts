import * as ts from "typescript";

export const CELL_RETURN_GLOBAL = "__agencityCellReturn_7f4d2b6a";
export const CELL_RETURN_GUARD_GLOBAL = "__agencityIsCellReturn_7f4d2b6a";

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Bun REPL mode supports either top-level await or top-level return, but not
 * both in one input because await makes the input an ECMAScript module.
 * Rewrite cell-level returns to an internal abrupt completion while leaving
 * nested function returns untouched. Catch clauses rethrow that completion so
 * user error handling cannot intercept an explicit cell return.
 */
export function prepareReplCellSource(code: string): string {
  const source = ts.createSourceFile(
    "cell.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edits: Edit[] = [];
  const catchClauses: ts.CatchClause[] = [];
  let catchIndex = 0;
  let hasCellReturn = false;

  const visit = (node: ts.Node): void => {
    if (node !== source && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      hasCellReturn = true;
      const expression = node.expression
        ? code.slice(node.expression.getStart(source), node.expression.getEnd())
        : "undefined";
      edits.push({
        start: node.getStart(source),
        end: node.getEnd(),
        text: `throw globalThis.${CELL_RETURN_GLOBAL}(${expression});`,
      });
      return;
    }
    if (ts.isCatchClause(node)) {
      catchClauses.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (hasCellReturn) {
    for (const node of catchClauses) {
      const blockStart = node.block.getStart(source);
      const declaration = node.variableDeclaration;
      const binding = declaration?.name;
      if (binding && ts.isIdentifier(binding)) {
        edits.push({
          start: blockStart + 1,
          end: blockStart + 1,
          text: `if(globalThis.${CELL_RETURN_GUARD_GLOBAL}(${binding.text}))throw ${binding.text};`,
        });
        continue;
      }
      const name = `__agencityCaught_${catchIndex++}`;
      edits.push({
        start: node.getStart(source),
        end: blockStart,
        text: `catch (${name}) `,
      });
      const restoreBinding = declaration
        ? `const ${code.slice(
          declaration.getStart(source),
          declaration.getEnd(),
        )}=${name};`
        : "";
      edits.push({
        start: blockStart + 1,
        end: blockStart + 1,
        text: `if(globalThis.${CELL_RETURN_GUARD_GLOBAL}(${name}))throw ${name};${restoreBinding}`,
      });
    }
  }

  let output = code;
  for (const edit of edits.sort((left, right) =>
    right.start - left.start || right.end - left.end
  )) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  const lastStatement = source.statements.at(-1);
  if (!lastStatement || !ts.isExpressionStatement(lastStatement)) {
    output = `${output}\nnull`;
  }
  return output;
}
