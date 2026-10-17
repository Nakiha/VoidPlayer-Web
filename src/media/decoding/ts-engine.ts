// Compatibility for the accepted finite-TS engine API; implementation is shared
// with Matroska without sharing reader/cursor or decoder ownership.
import {JsContainerEngine} from './js-container-engine.ts';
export class TsEngine extends JsContainerEngine {
  constructor(...args: [ConstructorParameters<typeof JsContainerEngine>[0], string, ConstructorParameters<typeof JsContainerEngine>[2]?]) {super(...args);}
  override get packetIndex(){const index=super.packetIndex;return index?.kind==='js-ts-packets'?index:undefined;}
  override async prepare(...args:Parameters<JsContainerEngine['prepare']>){await super.prepare(...args);return this.packetIndex!;}
}
