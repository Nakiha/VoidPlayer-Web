export type OpenStage = 'input' | 'container' | 'codec' | 'decode' | 'resource';
export class MediaOpenError extends Error {
  readonly stage: OpenStage;
  constructor(stage: OpenStage, message: string) {
    super(message);
    this.name = 'MediaOpenError';
    this.stage = stage;
  }
}
