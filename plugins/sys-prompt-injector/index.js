'use strict';
module.exports = {
  onPluginInit: function (context) { context.log('插件初始化完成'); },
  beforeRequest: function (ctx, context) {
    if (ctx && ctx.request && Array.isArray(ctx.request.messages)) {
      context.log('处理请求，消息数量：' + ctx.request.messages.length);
    }
    return ctx;
  },
  afterResponse: function (ctx, context) { context.log('上游请求已完成'); },
  onRequestError: function (ctx, context) { context.log('请求错误：' + (ctx.error || 'unknown')); },
  onServerStart: function (ctx, context) { context.log('服务已启动'); }
};
