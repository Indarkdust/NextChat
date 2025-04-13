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

      // 尝试请求，最多重试2次
      let res;
      let retryCount = 0;
      const maxRetries = 2;
      
      while (retryCount <= maxRetries) {
        try {
          res = await fetch(chatPath, chatPayload);
          
          if (res.ok) {
            break; // 成功获取响应，退出循环
          } else if (res.status === 500 && retryCount < maxRetries) {
            // 如果是500错误，并且还有重试次数，则等待后重试
            retryCount++;
            console.warn(`[Vision Model] HTTP 500 error, retrying (${retryCount}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // 指数退避
            continue;
          } else {
            // 其他错误或已达到最大重试次数
            const errorText = await res.text();
            console.error(`[Vision Model] Request failed with status: ${res.status}`);
            console.error("[Vision Model] Error response:", errorText);
            
            // 尝试解析错误响应
            try {
              const errorJson = JSON.parse(errorText);
              if (errorJson.error && errorJson.error.includes("Fetching image failed")) {
                throw new Error("图像获取失败，可能是图片链接已过期或图片格式不受支持。请尝试使用较小的图片或不同的图片格式（如JPEG或PNG）。");
              } else {
                throw new Error(`Vision model request failed: ${res.status} ${errorText}`);
              }
            } catch (parseErr) {
              throw new Error(`Vision model request failed: ${res.status} ${errorText}`);
            }
          }
        } catch (fetchErr) {
          if (retryCount < maxRetries) {
            retryCount++;
            console.warn(`[Vision Model] Fetch error, retrying (${retryCount}/${maxRetries})...`, fetchErr);
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            continue;
          }
          throw fetchErr; // 重试结束，抛出最后一个错误
        }
      }

      // 确保res已定义
      if (!res) {
        throw new Error("请求失败，无法连接到服务器");
      }
      
      const resJson = await res.json();
      console.log("[Vision Model] Raw response:", resJson);
      
      // 检查错误信息
      if (resJson.error) {
        console.error("[Vision Model] API returned error:", resJson.error);
        throw new Error(resJson.error.message || "视觉模型返回错误");
      }
      
      // 直接获取内容，grok-2-vision没有reasoning_content
      const description = resJson.choices?.at(0)?.message?.content || "";
      
      if (!description || description.trim() === "") {
        console.error("[Vision Model] Empty description returned");
        throw new Error("视觉模型返回了空的描述");
      }
      
      console.log("[Vision Model] Generated description:", description);
      
      return description;
    } catch (e) {
      console.error("[Vision Model] Failed to process image with vision model", e);
      
      // 根据错误类型返回更详细的错误信息
      let errorMessage = "图像处理过程中遇到了问题。";
      
      if (e instanceof Error) {
        if (e.message.includes("Fetching image failed")) {
          errorMessage = "图像获取失败，可能是图片链接已过期或图片格式不受支持。请尝试使用较小的图片（小于10MB）或确认您使用的是JPEG或PNG格式的图片。";
        } else if (e.message.includes("500")) {
          errorMessage = "服务器在处理图像时遇到内部错误。这可能是因为图像太大（请控制在10MB以内）或格式不受支持（仅支持JPEG/PNG）。";
        } else {
          errorMessage = `图像处理错误: ${e.message}`;
        }
      }
      
      return errorMessage;
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
    
    if (isVisionModel) {
      // 如果是视觉模型，使用现有的preProcessImageContent函数处理图像
      console.log("[Image Processing] Using vision model directly:", modelName);
      processedMessages = [];
      for (const msg of options.messages) {
        const content = await preProcessImageContent(msg.content);
        processedMessages.push({ role: msg.role, content });
      }
    } else if (hasImageContent) {
      // 非视觉模型但含有图像：使用grok-2-vision先处理图像，再传给目标模型
      console.log("[Image Processing] Processing images with vision model for non-vision model");
      
      // 步骤1: 创建基础消息数组（保留所有不含图像的消息）
      processedMessages = [];
      for (let i = 0; i < options.messages.length; i++) {
        const msg = options.messages[i];
        
        if (typeof msg.content === "string" || !msg.content.some(item => item.type === "image_url")) {
          // 不包含图像的消息直接添加
          processedMessages.push({ role: msg.role, content: msg.content });
        } else {
          // 包含图像的消息需要处理
          try {
            // 使用grok-2-vision获取图像描述
            const imageMessages = [msg];
            const imageDescription = await this.processImageWithVisionModel(imageMessages, "grok-2-vision-latest");
            
            // 提取消息中的文本部分
            let textContent = "";
            if (typeof msg.content !== "string") {
              const textParts = msg.content
                .filter(item => item.type === "text")
                .map(item => item.text);
              textContent = textParts.join("\n").trim();
            }
            
            // 创建新消息，包含图像描述和原文本
            let newContent = "";
            
            if (imageDescription && imageDescription.trim() !== "") {
              newContent += `[图像内容]: ${imageDescription}\n\n`;
            } else {
              newContent += "[图像内容]: 无法获取图像描述。\n\n";
            }
            
            if (textContent) {
              newContent += `[用户问题]: ${textContent}`;
            } else {
              newContent += "请描述这个图像。";
            }
            
            processedMessages.push({ role: msg.role, content: newContent });
            console.log("[Image Processing] Processed image with vision model:", newContent.substring(0, 100) + "...");
          } catch (e) {
            console.error("[Image Processing] Error processing image:", e);
            // 错误处理：如果图像处理失败，使用默认文本
            const textContent = typeof msg.content === "string" ? msg.content : getMessageTextContent(msg);
            const errorContent = `[图像处理错误]: 处理图像时出现问题，无法获取图像描述。\n\n[用户问题]: ${textContent || "请描述这个图像。"}`;
            processedMessages.push({ role: msg.role, content: errorContent });
          }
        }
      }
    } else {
      // 不含图像的普通消息处理
      processedMessages = [...options.messages];
    }

    // 检查是否需要排除某些惩罚参数
    const shouldExcludePenalties = shouldExcludePresenceFrequencyPenalty(modelName);
    
    // 只有grok-3-mini模型支持reasoning_effort参数
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

    // 只为支持reasoning_effort的模型添加该参数
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
        // 其余stream处理逻辑保持不变
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
                reasoning_content?: string;
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
