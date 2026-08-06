import * as ts from "typescript";

function hasCellReturn(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    if (node !== root && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/**
 * Rewrites only the last top-level expression into a return. A return belonging
 * to the cell (including one inside cell-level control flow) disables the
 * rewrite; returns inside nested functions do not.
 */
export function notebookCellBody(code: string): string {
  const source = ts.createSourceFile("cell.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (hasCellReturn(source)) return code;
  const statement = source.statements.at(-1);
  if (!statement || !ts.isExpressionStatement(statement)) return code;
  const start = statement.getStart(source);
  const expressionStart = statement.expression.getStart(source);
  const expressionEnd = statement.expression.getEnd();
  return `${code.slice(0, start)}return (
${code.slice(expressionStart, expressionEnd)}
);${code.slice(statement.getEnd())}`;
}
