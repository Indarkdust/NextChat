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
        for (let j = 0; j < message.content.length; j++) {
          const content = message.content[j];
          
          // 处理图像URL
          if (content && content.type === 'image_url' && content.image_url && content.image_url.url) {
            const url = content.image_url.url;
            
            // 如果URL不是data:开头（不是base64），则尝试代理
            if (!url.startsWith('data:')) {
              try {
                console.log(`[XAI Image Proxy] Converting URL to base64: ${url.substring(0, 50)}...`);
                
                // 处理 c.darkdust.xyz 上的缓存图片
                if (url.includes('c.darkdust.xyz/api/cache')) {
                  console.log('[XAI Image Proxy] Detected c.darkdust.xyz cache API URL');
                  // 这里首先尝试直接获取图像，如果失败，可以考虑通过其他方式处理
                  try {
                    // 从URL中提取缓存ID
                    const cacheId = url.split('/').pop()?.split('.')[0];
                    if (cacheId) {
                      console.log(`[XAI Image Proxy] Extracted cache ID: ${cacheId}`);
                    }
                  } catch (extractError) {
                    console.error('[XAI Image Proxy] Failed to extract cache ID:', extractError);
                  }
                }
                
                const base64Url = await fetchImageAsBase64(url);
                content.image_url.url = base64Url;
                console.log('[XAI Image Proxy] Successfully converted image to base64');
              } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`[XAI Image Proxy] Failed to proxy image: ${errorMessage}`);
                
                // 对于 c.darkdust.xyz 域名的错误，提供更详细的错误信息
                if (url.includes('c.darkdust.xyz')) {
                  console.error(`[XAI Image Proxy] This appears to be an internal domain image. Check that the cache API is working correctly and the image exists.`);
                  
                  // 使用PNG格式的占位图，而不是SVG（因为XAI只支持JPG/PNG）
                  // 这是一个1x1像素的透明PNG
                  const fallbackPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAAGQCAYAAACAvzbMAAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAAsTAAALEwEAmpwYAAABFklEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAOmrQABBJn+pQAAAABJRU5ErkJggg==';

                  // 为了保持请求继续，提供一个简单的透明图片
                  content.image_url.url = fallbackPng;
                  
                  // 在请求负载中添加文本说明，告知图像获取失败
                  message.content.unshift({
                    type: "text",
                    text: "[注意: 图像获取失败。原始图像URL: " + url + ". 错误信息: " + errorMessage + "]"
                  });
                }
              }
            }
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
