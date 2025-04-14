import { getServerSideConfig } from "@/app/config/server";
import {
  XAI_BASE_URL,
  ApiPath,
  ModelProvider,
  ServiceProvider,
} from "@/app/constant";
import { prettyObject } from "@/app/utils/format";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth";
import { isModelNotavailableInServer } from "@/app/utils/model";

const serverConfig = getServerSideConfig();

// 添加fetch函数，用于下载并转换为base64
async function fetchImageAsBase64(url: string): Promise<string> {
  try {
    // 检查是否是当前域名的URL
    const isLocalDomain = url.includes('c.darkdust.xyz') || url.includes('localhost') || url.includes('127.0.0.1');
    
    console.log(`[XAI Image Proxy] Fetching image from: ${url} (${isLocalDomain ? 'local domain' : 'external domain'})`);
    
    const fetchOptions: RequestInit = {
      headers: {
        // 添加常见浏览器请求头以避免被某些服务器拒绝
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      }
    };
    
    // 如果是当前域名，添加更宽松的CORS设置
    if (isLocalDomain) {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        'Origin': 'https://c.darkdust.xyz',
        'Referer': 'https://c.darkdust.xyz/'
      };
      fetchOptions.credentials = 'include';
    }
    
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[XAI Image Proxy] Error fetching image: ${errorMessage}`);
    throw error;
  }
}

// 处理图像URL，将外部URL代理为base64数据
async function processImageUrls(body: any): Promise<any> {
  if (!body || typeof body !== 'object') return body;

  // 处理messages数组
  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const message = body.messages[i];
      
      // 处理多模态内容
      if (message && Array.isArray(message.content)) {
        const textContent: string[] = [];
        const validImageParts = [];
        
        // 首先收集所有文本内容和有效图像内容
        for (let j = 0; j < message.content.length; j++) {
          const content = message.content[j];
          
          if (content?.type === "text" && content.text) {
            textContent.push(content.text);
          }
          // 处理图像URL
          else if (content?.type === "image_url" && content?.image_url?.url) {
            const url = content.image_url.url;
            
            // 如果URL不是data:开头（不是base64），则尝试代理
            if (!url.startsWith('data:')) {
              try {
                console.log(`[XAI Image Proxy] Converting URL to base64: ${url.substring(0, 50)}...`);
                
                // 处理 c.darkdust.xyz 上的缓存图片
                if (url.includes('c.darkdust.xyz/api/cache')) {
                  console.log('[XAI Image Proxy] Detected c.darkdust.xyz cache API URL');
                  // 从URL中提取缓存ID
                  try {
                    const cacheId = url.split('/').pop()?.split('.')[0];
                    if (cacheId) {
                      console.log(`[XAI Image Proxy] Extracted cache ID: ${cacheId}`);
                    }
                  } catch (extractError) {
                    console.error('[XAI Image Proxy] Failed to extract cache ID:', extractError);
                  }
                }
                
                const base64Url = await fetchImageAsBase64(url);
                
                // 验证base64Url是否为有效图像格式
                if (base64Url && 
                   (base64Url.startsWith('data:image/jpeg') || 
                    base64Url.startsWith('data:image/png') || 
                    base64Url.startsWith('data:image/gif'))) {
                  
                  // 保留有效图像
                  validImageParts.push({
                    type: "image_url",
                    image_url: { url: base64Url }
                  });
                  console.log('[XAI Image Proxy] Successfully converted image to base64');
                } else {
                  console.error('[XAI Image Proxy] Invalid image format:', base64Url.substring(0, 50));
                  throw new Error('Invalid image format');
                }
              } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`[XAI Image Proxy] Failed to proxy image: ${errorMessage}`);
                
                // 记录错误但不添加无效图像到有效列表中
                textContent.push(`[图像无法加载] 原始URL: ${url}. 错误: ${errorMessage}`);
              }
            } else {
              // 已经是base64格式，直接添加到有效图像列表
              validImageParts.push(content);
            }
          } else {
            // 其他类型的内容，直接保留
            validImageParts.push(content);
          }
        }
        
        // 根据模型是否为grok-2-vision-latest处理
        if (body.model === 'grok-2-vision-latest' || body.model === 'grok-2-vision') {
          if (validImageParts.length > 0) {
            // 只保留有效的图像和文本组合
            message.content = [
              {
                type: "text",
                text: textContent.join("\n\n")
              },
              ...validImageParts
            ].filter(item => {
              // 过滤掉空文本
              if (item.type === "text" && (!item.text || item.text.trim() === '')) {
                return false;
              }
              return true;
            });
          } else {
            // 如果没有有效图像，只保留文本并添加提示
            const errorText = "警告：无法加载图像，请检查图像URL是否有效或尝试不同的图像。";
            if (textContent.length > 0) {
              message.content = [{
                type: "text", 
                text: `${errorText}\n\n${textContent.join("\n\n")}`
              }];
            } else {
              message.content = [{
                type: "text",
                text: errorText
              }];
            }
          }
        } else {
          // 对于其他模型，直接移除包含无效图像的消息
          // 或者将其转换为纯文本消息
          if (validImageParts.length === 0 && textContent.length > 0) {
            // 如果没有有效图像但有文本，转换为纯文本消息
            message.content = textContent.join("\n\n");
          } else if (validImageParts.length > 0) {
            // 有有效图像，保留这些图像和文本
            message.content = [
              {
                type: "text", 
                text: textContent.join("\n\n")
              },
              ...validImageParts
            ].filter(item => {
              // 过滤掉空文本
              if (item.type === "text" && (!item.text || item.text.trim() === '')) {
                return false;
              }
              return true;
            });
          } else {
            // 既没有有效图像也没有文本，提供一个默认消息
            message.content = "请提供有效的图像或问题。";
          }
        }
      }
    }
  }

  return body;
}

// 添加一个图像代理路由处理函数
export async function handleProxyImage(req: NextRequest) {
  try {
    // 获取请求参数
    const url = req.nextUrl.searchParams.get('url');
    const cacheId = req.nextUrl.searchParams.get('cacheId');
    
    if (!url) {
      return NextResponse.json({ 
        error: 'Missing URL parameter'
      }, { status: 400 });
    }
    
    console.log(`[XAI Proxy Image] Proxying image: ${url}, cacheId: ${cacheId || 'none'}`);
    
    // 直接请求图像
    try {
      const base64Data = await fetchImageAsBase64(url);
      console.log(`[XAI Proxy Image] Successfully proxied image: ${url.substring(0, 50)}...`);
      
      // 返回base64数据
      return new NextResponse(base64Data, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=86400' // 缓存24小时
        }
      });
    } catch (error) {
      console.error(`[XAI Proxy Image] Error proxying image:`, error);
      
      // 如果有缓存ID，尝试从文件系统或其他存储中获取
      if (cacheId) {
        console.log(`[XAI Proxy Image] Trying to retrieve image from cache with ID: ${cacheId}`);
        
        // 这里可以添加从缓存系统直接获取图像的逻辑
        // 例如从文件系统或数据库读取
        
        // 为了演示，我们现在返回一个1x1像素的透明PNG
        const fallbackPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        
        return new NextResponse(fallbackPng, {
          headers: {
            'Content-Type': 'text/plain'
          }
        });
      }
      
      return NextResponse.json({ 
        error: 'Failed to proxy image' 
      }, { status: 500 });
    }
  } catch (error) {
    console.error(`[XAI Proxy Image] Unhandled error:`, error);
    return NextResponse.json({ 
      error: 'Internal server error'
    }, { status: 500 });
  }
}

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[XAI Route] params ", params);

  // 检查是否是代理图像的请求
  if (req.nextUrl.pathname.endsWith('/proxy-image')) {
    return handleProxyImage(req);
  }

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.XAI);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  try {
    const response = await request(req);
    return response;
  } catch (e) {
    console.error("[XAI] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

async function request(req: NextRequest) {
  const controller = new AbortController();

  // 从路径中移除API前缀
  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.XAI, "");

  let baseUrl = serverConfig.xaiUrl || XAI_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[XAI Proxy] Path: ", path);
  console.log("[XAI Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  const fetchUrl = `${baseUrl}${path}`;
  
  // 从请求中获取并处理请求体
  let requestBody;
  let bodyString = "";
  
  if (req.body) {
    try {
      // 克隆请求体，因为它只能被读取一次
      bodyString = await req.text();
      try {
        // 尝试解析JSON请求体
        requestBody = JSON.parse(bodyString);
        console.log("[XAI] Request payload:", JSON.stringify(requestBody, null, 2));
        
        // 确保请求中包含必要的字段
        if (path.includes("/chat/completions") && !requestBody.messages) {
          return NextResponse.json(
            {
              error: true,
              message: "请求缺少必要的messages字段",
            },
            { status: 400 }
          );
        }
        
        // 如果没有指定模型，设置默认模型
        if (!requestBody.model) {
          requestBody.model = "grok-3";
          console.log("[XAI] 未指定模型，使用默认模型: grok-3");
        }

        // 对于视觉模型请求，处理图片URL
        if (requestBody.model.includes("vision") || path.includes("/chat/completions")) {
          console.log("[XAI] 检测到可能的视觉模型请求，处理图片URL");
          requestBody = await processImageUrls(requestBody);
        }
        
        // 将修改后的请求体重新序列化
        bodyString = JSON.stringify(requestBody);
      } catch (e) {
        console.error("[XAI] Failed to parse request body as JSON:", e);
      }
    } catch (e) {
      console.error("[XAI] Failed to read request body:", e);
    }
  }

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.get("Authorization") ?? "",
    },
    method: req.method,
    body: bodyString || null,
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  // 检查自定义模型限制
  if (serverConfig.customModels && requestBody) {
    // 不需要再次读取body了，因为我们已经有了解析后的requestBody
    if (
      isModelNotavailableInServer(
        serverConfig.customModels,
        requestBody?.model as string,
        ServiceProvider.XAI as string,
      )
    ) {
      return NextResponse.json(
        {
          error: true,
          message: `你没有权限使用 ${requestBody?.model} 模型`,
        },
        {
          status: 403,
        },
      );
    }
  }

  // 打印实际请求详情，便于调试
  console.log(`[XAI] Request URL: ${fetchUrl}, Method: ${req.method}`);

  try {
    console.log(`[XAI] Making request to: ${fetchUrl}`);
    const res = await fetch(fetchUrl, fetchOptions);

    // 记录响应状态
    console.log(`[XAI] Response status: ${res.status} ${res.statusText}`);

    // 处理错误响应
    if (res.status >= 400) {
      try {
        const errorData = await res.clone().json();
        console.error(`[XAI] Error ${res.status} details:`, errorData);
        return NextResponse.json(
          {
            error: true,
            message: `X.AI API 错误 (${res.status}): ${JSON.stringify(errorData)}`,
            details: errorData,
          },
          { status: res.status }
        );
      } catch (e) {
        // 如果无法解析JSON，尝试获取文本
        try {
          const errorText = await res.clone().text();
          console.error(`[XAI] Error ${res.status} text:`, errorText);
          return NextResponse.json(
            {
              error: true,
              message: `X.AI API 错误 (${res.status}): ${errorText}`,
            },
            { status: res.status }
          );
        } catch (textError) {
          console.error(`[XAI] Failed to parse error response:`, textError);
        }
      }
    }

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
