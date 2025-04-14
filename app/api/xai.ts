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

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[XAI Route] params ", params);

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
