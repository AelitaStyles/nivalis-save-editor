export class SaveFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SaveFormatError';
  }
}

export class UnsupportedEditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedEditError';
  }
}
