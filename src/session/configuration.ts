import {captureDecodeConfiguration, setColorMode, setReferenceDecode} from '../media/policy/color-mode.ts';
import {getColorOutput, setColorOutput} from '../../shared/color/color-output.ts';
import type {ColorOutput} from '../../shared/color/color-output.ts';
import type {DecodeConfiguration} from '../../shared/color/decode-policy-types.ts';

type Configuration = DecodeConfiguration & {readonly colorOutput: ColorOutput};
/** Session-owned configuration critical section. New source intents may cancel
 * observation immediately, but cannot capture conditions before rollback ends. */
export class SessionConfiguration {
  private active?: Promise<void>;
  private previous?:Configuration;
  get pending(){return !!this.active;}
  defaults(){return this.previous??this.snapshot();}
  snapshot(): Configuration {
    return Object.freeze({...captureDecodeConfiguration(), colorOutput: getColorOutput()});
  }
  apply(value: Configuration) {
    setColorMode(value.colorMode);
    setReferenceDecode(value.referenceDecode);
    setColorOutput(value.colorOutput);
  }
  settled() { return this.active ?? Promise.resolve(); }
  async run<T>(work: (previous: Configuration) => Promise<T>): Promise<T> {
    if(this.active)throw Error('Session configuration transactions must be serialized');
    let release!: () => void;
    const active = new Promise<void>(resolve => release = resolve);
    const previous=this.snapshot();
    this.active = active;this.previous=previous;
    try { return await work(previous); }
    finally { if(this.active === active){this.active = undefined;this.previous=undefined;}release(); }
  }
}
