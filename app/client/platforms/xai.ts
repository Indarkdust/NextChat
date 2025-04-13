"use client";
// azure and openai, using same models. so using same LLMApi.
import { ApiPath, XAI_BASE_URL, XAI } from "@/app/constant";
import {
  useAccessStore,
  useAppConfig,
  useChatStore,
  ChatMessageTool,
  usePluginStore,
} from "@/app/store";
import { streamWithThink } from "@/app/utils/chat";
import {
  ChatOptions,
  getHeaders,
  LLMApi,
  LLMModel,
  SpeechOptions,
} from "../api";
import { getClientConfig } from "@/app/config/client";
import { getTimeoutMSByModel, shouldExcludePresenceFrequencyPenalty } from "@/app/utils";
import { preProcessImageContent } from "@/app/utils/chat";
import { RequestPayload } from "./openai";
import { fetch } from "@/app/utils/stream";

export class XAIApi implements LLMApi {
  private disableListModels = true;

  path(path: string): string {
    const accessStore = useAccessStore.getState();

    let baseUrl = "";

    if (accessStore.useCustomConfig) {
      baseUrl = accessStore.xaiUrl;
    }

    if (baseUrl.length === 0) {
      const isApp = !!getClientConfig()?.isApp;
      const apiPath = ApiPath.XAI;
      baseUrl = isApp ? XAI_BASE_URL : apiPath;
    }

    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    if (!baseUrl.startsWith("http") && !baseUrl.startsWith(ApiPath.XAI)) {
      baseUrl = "https://" + baseUrl;
    }

    console.log("[Proxy Endpoint] ", baseUrl, path);

    return [baseUrl, path].join("/");
  }

  extractMessage(res: any) {
    // 检查是否存在reasoning_content
    const reasoningContent = res.choices?.at(0)?.message?.reasoning_content;
    const content = res.choices?.at(0)?.message?.content ?? "";
    
    // 如果存在reasoning_content，添加到返回内容中
    if (reasoningContent) {
      return `> ${reasoningContent}\n\n${content}`;
    }
    
    return content;
  }

  speech(options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error("Method not implemented.");
  }

  async chat(options: ChatOptions) {
    const messages: ChatOptions["messages"] = [];
    for (const v of options.messages) {
      const content = await preProcessImageContent(v.content);
      messages.push({ role: v.role, content });
    }

    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
        providerName: options.config.providerName,
      },
    };

    const modelName = modelConfig.model;
    const shouldExcludePenalties = shouldExcludePresenceFrequencyPenalty(modelName);
    const isGrokModel = modelName.includes("grok-3-mini");

    // 创建基础请求负载
    const basePayload: any = {
      messages,
      stream: options.config.stream,
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      top_p: modelConfig.top_p,
    };

    // 只有当模型支持这些参数时才添加它们
    if (!shouldExcludePenalties) {
      basePayload.presence_penalty = modelConfig.presence_penalty;
      basePayload.frequency_penalty = modelConfig.frequency_penalty;
    }

    // 为grok模型添加reasoning_effort参数
    if (isGrokModel) {
      basePayload.reasoning_effort = "high";
    }

    // 将请求负载类型转换为 RequestPayload
    const requestPayload = basePayload as RequestPayload;

    console.log("[Request] xai payload: ", requestPayload);

    const shouldStream = !!options.config.stream;
    const controller = new AbortController();
    options.onController?.(controller);

    try {
      const chatPath = this.path(XAI.ChatPath);
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        headers: getHeaders(),
      };

      // make a fetch request
      const requestTimeoutId = setTimeout(
        () => controller.abort(),
        getTimeoutMSByModel(options.config.model),
      );

      if (shouldStream) {
        const [tools, funcs] = usePluginStore
          .getState()
          .getAsTools(
            useChatStore.getState().currentSession().mask?.plugin || [],
          );
        return streamWithThink(
          chatPath,
          requestPayload,
          getHeaders(),
          tools as any,
          funcs,
          controller,
          // parseSSE
          (text: string, runTools: ChatMessageTool[]) => {
            console.log("[X.AI Debug] Raw SSE Text:", text);
            const json = JSON.parse(text);
            console.log("[X.AI Debug] Parsed JSON:", json);
            const choices = json.choices as Array<{
              delta: {
                content: string;
                tool_calls: ChatMessageTool[];
                reasoning_content?: string;  // 添加对reasoning_content的支持
              };
            }>;
            console.log("[X.AI Debug] Delta content:", choices[0]?.delta?.content);
            console.log("[X.AI Debug] Reasoning content:", choices[0]?.delta?.reasoning_content);
            
            const tool_calls = choices[0]?.delta?.tool_calls;
            if (tool_calls?.length > 0) {
              const index = tool_calls[0]?.index;
              const id = tool_calls[0]?.id;
              const args = tool_calls[0]?.function?.arguments;
              if (id) {
                runTools.push({
                  id,
                  type: tool_calls[0]?.type,
                  function: {
                    name: tool_calls[0]?.function?.name as string,
                    arguments: args,
                  },
                });
              } else {
                // @ts-ignore
                runTools[index]["function"]["arguments"] += args;
              }
            }

            // 处理reasoning_content，支持显示思考过程
            const reasoning = choices[0]?.delta?.reasoning_content;
            const content = choices[0]?.delta?.content;

            // 如果存在reasoning_content，则显示为思考过程
            if (reasoning && reasoning.length > 0) {
              return {
                isThinking: true,
                content: reasoning,
              };
            }
            
            return {
              isThinking: false,
              content: content || "",
            };
          },
          // processToolMessage, include tool_calls message and tool call results
          (
            requestPayload: RequestPayload,
            toolCallMessage: any,
            toolCallResult: any[],
          ) => {
            // @ts-ignore
            requestPayload?.messages?.splice(
              // @ts-ignore
              requestPayload?.messages?.length,
              0,
              toolCallMessage,
              ...toolCallResult,
            );
          },
          options,
        );
      } else {
        const res = await fetch(chatPath, chatPayload);
        clearTimeout(requestTimeoutId);

        const resJson = await res.json();
        const message = this.extractMessage(resJson);
        options.onFinish(message, res);
      }
    } catch (e) {
      console.log("[Request] failed to make a chat request", e);
      options.onError?.(e as Error);
    }
  }

  async usage() {
    return {
      used: 0,
      total: 0,
    };
  }

  async models(): Promise<LLMModel[]> {
    return [];
  }
}
