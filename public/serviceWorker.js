const CHATGPT_NEXT_WEB_CACHE = "chatgpt-next-web-cache";
const CHATGPT_NEXT_WEB_FILE_CACHE = "chatgpt-next-web-file";
let a="useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";let nanoid=(e=21)=>{let t="",r=crypto.getRandomValues(new Uint8Array(e));for(let n=0;n<e;n++)t+=a[63&r[n]];return t};

self.addEventListener("activate", function (event) {
  console.log("ServiceWorker activated.");
});

self.addEventListener("install", function (event) {
  self.skipWaiting();  // enable new version
  event.waitUntil(
    caches.open(CHATGPT_NEXT_WEB_CACHE).then(function (cache) {
      return cache.addAll([]);
    }),
  );
});

function jsonify(data) {
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
}

async function upload(request, url) {
  const formData = await request.formData()
  const file = formData.getAll('file')[0]
  let ext = file.name.split('.').pop()
  if (ext === 'blob') {
    ext = file.type.split('/').pop()
  }
  const fileUrl = `${url.origin}/api/cache/${nanoid()}.${ext}`
  // console.debug('file', file, fileUrl, request)
  const cache = await caches.open(CHATGPT_NEXT_WEB_FILE_CACHE)
  await cache.put(new Request(fileUrl), new Response(file, {
    headers: {
      'content-type': file.type,
      'content-length': file.size,
      'cache-control': 'no-cache', // file already store in disk
      'server': 'ServiceWorker',
    }
  }))
  return jsonify({ code: 0, data: fileUrl })
}

async function remove(request, url) {
  const cache = await caches.open(CHATGPT_NEXT_WEB_FILE_CACHE)
  const res = await cache.delete(request.url)
  return jsonify({ code: 0 })
}

// 从URL中获取缓存键，忽略查询参数
function getCacheKeyFromUrl(url) {
  // 创建一个没有查询参数的URL用于缓存匹配
  // 例如 "/api/cache/abc.png?param=value" 变成 "/api/cache/abc.png"
  const urlObj = new URL(url);
  return urlObj.origin + urlObj.pathname;
}

self.addEventListener("fetch", (e) => {
  try {
    const url = new URL(e.request.url);
    
    if (/^\/api\/cache/.test(url.pathname)) {
      if ('GET' == e.request.method) {
        // 使用不含查询参数的URL作为缓存键
        e.respondWith(
          caches.open(CHATGPT_NEXT_WEB_FILE_CACHE).then(cache => {
            const cacheKey = getCacheKeyFromUrl(e.request.url);
            // 先尝试用精确URL查找缓存
            return cache.match(e.request).then(response => {
              if (response) {
                return response;
              }
              // 如果找不到，尝试使用不带查询参数的路径查找
              return cache.match(new Request(cacheKey));
            });
          })
        );
      }
      if ('POST' == e.request.method) {
        e.respondWith(upload(e.request, url));
      }
      if ('DELETE' == e.request.method) {
        e.respondWith(remove(e.request, url));
      }
    }
  } catch (error) {
    console.error("[ServiceWorker] Error handling fetch event:", error);
  }
});
