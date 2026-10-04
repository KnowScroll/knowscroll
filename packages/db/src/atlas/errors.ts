export class AtlasConflict extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'AtlasConflict';
  }
}
export class AtlasNotFound extends Error {
  readonly statusCode = 404;
  constructor(message = 'Not found') {
    super(message);
    this.name = 'AtlasNotFound';
  }
}
