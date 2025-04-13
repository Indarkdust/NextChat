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

    // 确保baseUrl格式正确
    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, baseUrl.length - 1);
    }
    
    // 修正URL格式以防止Invalid URL错误
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://") && !baseUrl.startsWith(ApiPath.XAI)) {
      baseUrl = "https://" + baseUrl;
    }
    
    // 确保path以/开头
    if (path && !path.startsWith("/")) {
      path = "/" + path;
    }

    const fullPath = `${baseUrl}${path}`;
    
    // 验证URL是否有效以防止Invalid URL错误
    try {
      new URL(fullPath);
      console.log("[Proxy Endpoint] ", fullPath);
      return fullPath;
    } catch (e) {
      console.error("[Proxy Endpoint] Invalid URL:", fullPath, e);
      // 返回一个安全的URL作为后备
      return baseUrl.startsWith(ApiPath.XAI) ? baseUrl + path : `https://api.x.ai/v1${path}`;
    }
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
      try {
        // 非视觉模型但含有图像：每次都强制使用grok-2-vision处理
        console.log("[Image Processing] Using grok-2-vision to process images for:", modelName);
        
        // 创建新的消息数组，处理每一条消息
        processedMessages = [];
        
        // 首先添加历史消息
        for (let i = 0; i < options.messages.length - 1; i++) {
          const msg = options.messages[i];
          if (typeof msg.content === "string") {
            processedMessages.push({ role: msg.role, content: msg.content });
          } else {
            // 历史消息中的图像内容，提取文本部分
            processedMessages.push({ 
              role: msg.role, 
              content: getMessageTextContent(msg) || "..." 
            });
          }
        }
        
        // 特别处理最后一条消息（通常是当前用户问题）
        const lastMsg = options.messages[options.messages.length - 1];
        
        if (typeof lastMsg.content === "string" || !lastMsg.content.some(item => item.type === "image_url")) {
          // 如果最后一条消息不包含图像，直接添加
          processedMessages.push({ role: lastMsg.role, content: lastMsg.content });
        } else {
          console.log("[Image Processing] Last message contains image, processing with grok-2-vision");
          
          // 提取文本部分
          let textContent = "";
          if (typeof lastMsg.content !== "string") {
            const textParts = lastMsg.content
              .filter(item => item.type === "text")
              .map(item => item.text);
            textContent = textParts.join("\n").trim();
          }
          
          // 使用grok-2-vision处理图像
          try {
            // 创建一个新的包含图像的消息数组
            const imageOnlyMessage = {
              role: lastMsg.role,
              content: lastMsg.content
            };
            
            // 使用视觉模型获取图像描述
            console.log("[Image Processing] Calling grok-2-vision for image description");
            const imageDescription = await this.processImageWithVisionModel(
              [imageOnlyMessage], 
              "grok-2-vision-latest"
            );
            console.log("[Image Processing] Got image description:", imageDescription.substring(0, 100) + "...");
            
            // 构建新消息，用于发送给非视觉模型
            let newContent = "";
            
            if (imageDescription && imageDescription.trim() !== "") {
              newContent += `[图像内容]:\n${imageDescription}\n\n`;
            }
            
            if (textContent) {
              newContent += `[用户问题]: ${textContent}`;
            } else {
              newContent += "请描述这个图像。";
            }
            
            // 添加处理后的消息
            processedMessages.push({ role: lastMsg.role, content: newContent });
            
            console.log("[Image Processing] Created message with image description:", 
              newContent.substring(0, 100) + (newContent.length > 100 ? "..." : ""));
          } catch (e) {
            console.error("[Image Processing] Failed to process image with vision model:", e);
            
            // 错误处理：如果图像处理失败，创建包含错误信息的消息
            const errorContent = `[图像处理错误]: 无法处理图像，可能是因为图像格式不支持、大小超限或网络问题。\n\n[用户问题]: ${textContent || "请描述这个图像。"}`;
            processedMessages.push({ role: lastMsg.role, content: errorContent });
          }
        }
      } catch (e) {
        console.error("[Image Processing] Critical error in image processing pipeline:", e);
        
        // 如果整个处理管道失败，回退到只处理文本内容
        processedMessages = options.messages.map(msg => ({
          role: msg.role,
          content: typeof msg.content === "string" ? msg.content : getMessageTextContent(msg) || "..."
        }));
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

    // 输出处理后的消息，便于调试
    if (hasImageContent && !isVisionModel) {
      console.log("[Request] Final processed messages for non-vision model with images:");
      requestPayload.messages.forEach((msg, i) => {
        const content = typeof msg.content === "string" 
          ? (msg.content.length > 100 ? msg.content.substring(0, 100) + "..." : msg.content)
          : "[Complex content]";
        console.log(`[${i}] ${msg.role}: ${content}`);
      });
    }

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
