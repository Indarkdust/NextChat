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
import { getTimeoutMSByModel, shouldExcludePresenceFrequencyPenalty, getMessageTextContent } from "@/app/utils";
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

  // 添加一个新方法，用于处理图像并获取描述
  private async processImageWithVisionModel(
    messages: ChatOptions["messages"],
    visionModel: string = "grok-2-vision-latest"
  ): Promise<string> {
    // 创建一个简单的消息数组，只包含图像和简单的提示文本
    const imageMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
    
    // 构建请求负载
    const requestPayload = {
      messages: imageMessages,
      model: visionModel,
      stream: false,
      temperature: 0.01, // 较低的温度以获取更确定的描述
    };

    console.log("[Request] Vision model payload: ", requestPayload);

    try {
      // 发送请求到视觉模型
      const chatPath = this.path(XAI.ChatPath);
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        headers: getHeaders(),
      };

      const res = await fetch(chatPath, chatPayload);
      const resJson = await res.json();
      
      if (!res.ok) {
        console.error("[Vision Model] request failed", resJson);
        throw new Error(`Vision model request failed: ${resJson.error?.message || "Unknown error"}`);
      }

      // 提取视觉模型的描述
      const description = this.extractMessage(resJson);
      console.log("[Vision Model] Generated description:", description);
      
      return description;
    } catch (e) {
      console.error("[Vision Model] failed to process image", e);
      throw e;
    }
  }

  async chat(options: ChatOptions) {
    const modelConfig = {
      ...useAppConfig.getState().modelConfig,
      ...useChatStore.getState().currentSession().mask.modelConfig,
      ...{
        model: options.config.model,
        providerName: options.config.providerName,
      },
    };

    // 检查是否包含图像内容
    const hasImageContent = options.messages.some(msg => 
      typeof msg.content !== "string" && 
      msg.content.some(item => item.type === "image_url")
    );
    
    // 检查当前模型是否支持视觉能力
    const modelName = modelConfig.model;
    const isVisionModel = modelName.includes("vision");

    let processedMessages = [];
    
    // 如果包含图像且当前模型不是视觉模型，则使用视觉模型处理
    if (hasImageContent && !isVisionModel) {
      try {
        console.log("[Image Processing] Detected image content with non-vision model, using vision model pipeline");
        
        // 获取最后一条消息（通常是用户的提问）
        const lastMessage = options.messages[options.messages.length - 1];
        
        // 从用户选择的视觉模型获取图像描述
        const imageDescription = await this.processImageWithVisionModel(
          options.messages,
          "grok-2-vision-latest" // 可以从配置或其他地方获取
        );
        
        // 创建新的消息数组，将图像描述添加为文本
        processedMessages = options.messages.slice(0, -1).map(msg => ({
          role: msg.role,
          content: typeof msg.content === "string" ? msg.content : getMessageTextContent(msg)
        }));
        
        // 提取最后一条消息的文本部分
        let userPrompt = "";
        if (typeof lastMessage.content === "string") {
          userPrompt = lastMessage.content;
        } else {
          // 从复合消息中提取文本部分
          const textParts = lastMessage.content
            .filter(item => item.type === "text")
            .map(item => item.text);
          userPrompt = textParts.join("\n");
        }
        
        // 构建新的用户消息，包含图像描述和原始问题
        const newUserMessage = {
          role: lastMessage.role,
          content: `[图像描述]: ${imageDescription}\n\n${userPrompt}`
        };
        
        processedMessages.push(newUserMessage);
        
        console.log("[Image Processing] Created new messages with image description");
      } catch (e) {
        console.error("[Image Processing] Failed to process image with vision model", e);
        // 出错时回退到原始消息，但移除图像内容
        processedMessages = options.messages.map(msg => ({
          role: msg.role,
          content: typeof msg.content === "string" ? msg.content : getMessageTextContent(msg)
        }));
      }
    } else {
      // 如果不需要处理图像，或者当前模型已经支持视觉，则正常处理
      processedMessages = [];
      for (const v of options.messages) {
        const content = await preProcessImageContent(v.content);
        processedMessages.push({ role: v.role, content });
      }
    }

    const shouldExcludePenalties = shouldExcludePresenceFrequencyPenalty(modelName);
    const isGrokModel = modelName.includes("grok-3-mini");

    // 创建基础请求负载
    const basePayload: any = {
      messages: processedMessages,
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
