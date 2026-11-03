/**
 * The `t3` object a plugin view gets: `await t3.call(name, input)` runs the plugin's handler,
 * `t3.ready(fn)` reports `{ pluginId, viewId, threadId }`. Messages are JSON-RPC shaped like the
 * html_render bootstrap's, and the client answers only this frame's window.
 */
const PLUGIN_VIEW_READY_METHOD = "t3/plugin.ready";
const PLUGIN_VIEW_INIT_METHOD = "t3/plugin.init";
const PLUGIN_VIEW_CALL_METHOD = "t3/plugin.call";
const PLUGIN_VIEW_CALL_ID_PREFIX = "t3-plugin-";

export const PLUGIN_VIEW_BRIDGE_SCRIPT = `(function(){if(window.parent===window)return;var n=0,p={},c=null,w=[];function post(m){window.parent.postMessage(m,"*");}window.addEventListener("message",function(e){var d=e.data;if(e.source!==window.parent||!d||d.jsonrpc!=="2.0")return;if(d.method===${JSON.stringify(PLUGIN_VIEW_INIT_METHOD)}&&d.params){c=d.params;window.t3.threadId=c.threadId||null;var q=w;w=[];q.forEach(function(f){f(c);});return;}if(typeof d.id==="string"&&p[d.id]){var r=p[d.id];delete p[d.id];if(d.error)r[1](new Error(d.error.message||"The plugin call failed."));else r[0](d.result);}});window.t3={threadId:null,call:function(h,i){return new Promise(function(res,rej){var id=${JSON.stringify(PLUGIN_VIEW_CALL_ID_PREFIX)}+(++n);p[id]=[res,rej];post({jsonrpc:"2.0",id:id,method:${JSON.stringify(PLUGIN_VIEW_CALL_METHOD)},params:{handler:String(h),input:i===undefined?null:i}});});},ready:function(f){if(c)f(c);else w.push(f);}};post({jsonrpc:"2.0",method:${JSON.stringify(PLUGIN_VIEW_READY_METHOD)}});})();`;

export type PluginViewMessage =
  | { readonly type: "ready" }
  | {
      readonly type: "call";
      readonly id: string;
      readonly handler: string;
      readonly input: unknown;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A bridge message a plugin view posted, or undefined for anything else. */
export function readPluginViewMessage(data: unknown): PluginViewMessage | undefined {
  if (!isRecord(data) || data.jsonrpc !== "2.0") return undefined;
  if (data.method === PLUGIN_VIEW_READY_METHOD) return { type: "ready" };
  if (
    data.method === PLUGIN_VIEW_CALL_METHOD &&
    typeof data.id === "string" &&
    data.id.startsWith(PLUGIN_VIEW_CALL_ID_PREFIX) &&
    isRecord(data.params) &&
    typeof data.params.handler === "string"
  ) {
    return { type: "call", id: data.id, handler: data.params.handler, input: data.params.input };
  }
  return undefined;
}

export function pluginViewInitMessage(context: {
  readonly pluginId: string;
  readonly viewId: string;
  readonly threadId: string | null;
}) {
  return { jsonrpc: "2.0", method: PLUGIN_VIEW_INIT_METHOD, params: context } as const;
}

export function pluginViewResultMessage(id: string, result: unknown) {
  return { jsonrpc: "2.0", id, result } as const;
}

export function pluginViewErrorMessage(id: string, message: string) {
  return { jsonrpc: "2.0", id, error: { message } } as const;
}
