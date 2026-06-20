import Parser from "tree-sitter";
import Moo from "tree-sitter-moo";

export type MooSyntaxNode = Parser.SyntaxNode;
export type MooTree = Parser.Tree;

export class MooParser {
  private readonly parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Moo as unknown as Parser.Language);
  }

  parse(source: string): MooTree {
    return this.parser.parse(source);
  }
}
