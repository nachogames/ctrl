/**
 * The `t3` object a plugin view page gets, injected after the theme bootstrap.
 *
 *   await t3.call(name, input)   runs the plugin's `ctx.handle(name, fn)` and returns its value
 *   t3.ready(fn)                 calls fn({ pluginId, viewId, threadId }) once the host answers
 *   t3.threadId                  the thread whose right panel shows the view, once ready
 *
 * Messages are JSON-RPC shaped like the html_render bootstrap's. The client
 * accepts them only from this frame's window and answers on it.
 */
export const PLUGIN_VIEW_READY_METHOD = "t3/plugin.ready";
export const PLUGIN_VIEW_INIT_METHOD = "t3/plugin.init";
export const PLUGIN_VIEW_CALL_METHOD = "t3/plugin.call";
export const PLUGIN_VIEW_CALL_ID_PREFIX = "t3-plugin-";

export const PLUGIN_VIEW_BRIDGE_SCRIPT = `(function(){if(window.parent===window)return;var n=0,p={},c=null,w=[];function post(m){window.parent.postMessage(m,"*");}window.addEventListener("message",function(e){var d=e.data;if(e.source!==window.parent||!d||d.jsonrpc!=="2.0")return;if(d.method===${JSON.stringify(PLUGIN_VIEW_INIT_METHOD)}&&d.params){c=d.params;window.t3.threadId=c.threadId||null;var q=w;w=[];q.forEach(function(f){f(c);});return;}if(typeof d.id==="string"&&p[d.id]){var r=p[d.id];delete p[d.id];if(d.error)r[1](new Error(d.error.message||"The plugin call failed."));else r[0](d.result);}});window.t3={threadId:null,call:function(h,i){return new Promise(function(res,rej){var id=${JSON.stringify(PLUGIN_VIEW_CALL_ID_PREFIX)}+(++n);p[id]=[res,rej];post({jsonrpc:"2.0",id:id,method:${JSON.stringify(PLUGIN_VIEW_CALL_METHOD)},params:{handler:String(h),input:i===undefined?null:i}});});},ready:function(f){if(c)f(c);else w.push(f);}};post({jsonrpc:"2.0",method:${JSON.stringify(PLUGIN_VIEW_READY_METHOD)}});})();`;
