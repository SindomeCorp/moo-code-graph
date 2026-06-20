export class CodeGraphError extends Error {
  constructor(
    message: string,
    readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CodeGraphError";
  }
}
