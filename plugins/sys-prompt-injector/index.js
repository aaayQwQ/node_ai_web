'use strict';

module.exports = {
  onPluginInit(context) {
    context.log('插件初始化完成');
  },

  beforeRequest(context, pluginAPI) {
    const request = context && context.request;
    if (!request || !Array.isArray(request.messages)) {
      return context;
    }

    pluginAPI.log('收到请求，消息数量：' + request.messages.length);
    return context;
  },

  afterResponse(context, pluginAPI) {
    pluginAPI.log('上游请求已完成');
  },

  onRequestError(context, pluginAPI) {
    pluginAPI.log('请求失败：' + (context.error || 'unknown'));
  },

  onServerStart(context, pluginAPI) {
    pluginAPI.log('服务已启动');
  }
};
