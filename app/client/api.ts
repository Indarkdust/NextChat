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
import Locale from "@/app/locales";

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

  extractMessage(res: any, options?: { skipReasoning?: boolean }) {
    // 检查是否存在reasoning_content
    const reasoningContent = res.choices?.at(0)?.message?.reasoning_content;
    const content = res.choices?.at(0)?.message?.content ?? "";
    
    // 如果设置了skipReasoning，或者是在生成摘要时，就不包含reasoning_content
    if (options?.skipReasoning || false) {
      return content;
    }
    
    // 正常对话时包含reasoning_content
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
    try {
      console.log("[Vision Model] Processing image with vision model:", visionModel);
      
      // 创建更明确的提示，告诉视觉模型提供详细描述
      let userMessage = messages[messages.length - 1];
      let userPrompt = "";

      if (typeof userMessage.content === "string") {
        userPrompt = userMessage.content;
      } else {
        // 从复合消息中提取文本部分
        const textParts = userMessage.content
          .filter(item => item.type === "text")
          .map(item => item.text);
        userPrompt = textParts.join("\n");
      }
      
      // 构建一个更明确的提示，告诉视觉模型我们需要什么
      const enhancedMessages = [...messages.slice(0, -1)];
      
      // 替换最后一条消息以提供更好的指导
      enhancedMessages.push({
        role: userMessage.role,
        content: [
          {
            type: "text",
            text: `请仔细描述这张图像，提供详细的内容描述，包括图像中的主要物体、场景、文字、颜色和布局等。${userPrompt ? "\n\n用户问题：" + userPrompt : ""}`
          },
          ...(typeof userMessage.content === "string" ? [] : 
              userMessage.content.filter(item => item.type === "image_url"))
        ]
      });
      
      // 构建请求负载
      const requestPayload = {
        messages: enhancedMessages,
        model: visionModel,
        stream: false,
        temperature: 0.01, // 较低的温度以获取更确定的描述
      };

      console.log("[Vision Model] Sending request to vision model");

      // 发送请求到视觉模型
      const chatPath = this.path(XAI.ChatPath);
      const chatPayload = {
        method: "POST",
        body: JSON.stringify(requestPayload),
        headers: getHeaders(),
      };

      const res = await fetch(chatPath, chatPayload);
      
      if (!res.ok) {
        console.error("[Vision Model] Request failed with status:", res.status);
        const errorText = await res.text();
        console.error("[Vision Model] Error response:", errorText);
        throw new Error(`Vision model request failed: ${res.status} ${errorText}`);
      }

      const resJson = await res.json();
      console.log("[Vision Model] Raw response:", resJson);
      
      // 提取视觉模型的描述
      const description = this.extractMessage(resJson);
      
      if (!description || description.trim() === "") {
        console.error("[Vision Model] Empty description returned");
        throw new Error("Vision model returned empty description");
      }
      
      console.log("[Vision Model] Generated description:", description);
      
      return description;
    } catch (e) {
      console.error("[Vision Model] Failed to process image with vision model", e);
      // 返回一个更详细、更友好的错误描述，而不是简单的"无法处理图像"
      return "图像处理过程中遇到了问题。这可能是因为图像格式不受支持、图像过大或网络连接问题。我将尝试回答您的问题，但无法分析图像内容。";
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
        
        // 从视觉模型获取图像描述
        const imageDescription = await this.processImageWithVisionModel(
          options.messages,
          "grok-2-vision-latest" // 使用grok-2-vision处理图像
        );
        
        // 创建新的消息数组，保留之前的消息
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
        // 使用更清晰的格式，明确区分图像描述和用户问题
        let finalContent = "";
        if (imageDescription && imageDescription.trim() !== "") {
          finalContent += `[图像内容]:\n${imageDescription}\n\n`;
        }
        
        if (userPrompt && userPrompt.trim() !== "") {
          finalContent += `[用户问题]:\n${userPrompt}`;
        } else {
          finalContent += "请描述这个图像。";
        }
        
        const newUserMessage = {
          role: lastMessage.role,
          content: finalContent
        };
        
        processedMessages.push(newUserMessage);
        
        console.log("[Image Processing] Created new messages with image description:", finalContent);
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
    
    // 按照最新信息，只有grok-3-mini模型支持并需要reasoning_effort参数
    const supportsReasoningEffort = modelName.includes("grok-3-mini");

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

    // 只为grok-3-mini模型添加该参数
    if (supportsReasoningEffort) {
      basePayload.reasoning_effort = "high";
    }

    // 将请求负载类型转换为 RequestPayload
    const requestPayload = basePayload as RequestPayload;

    console.log("[Request] xai payload:", requestPayload);

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
        
        // 检查是否是摘要请求 (当用户要求生成主题或摘要时的特殊标记)
        const isSummaryRequest = options.messages.some(m => 
          typeof m.content === "string" && 
          (m.content.includes(Locale.Store.Prompt.Topic) || 
           m.content.includes(Locale.Store.Prompt.Summarize))
        );
        
        // 为摘要请求跳过reasoning_content
        const message = this.extractMessage(resJson, { skipReasoning: isSummaryRequest });
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
