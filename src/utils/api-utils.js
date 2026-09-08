export function getProviderFormat(provider) {
  if (provider.format) return provider.format;
  
  // Tự động fallback lại detection nếu thiếu dữ liệu cho Backward-Compatibility
  let uri = provider.baseUrl || "https://generativelanguage.googleapis.com";
  try {
    const urlObj = new URL(uri);
    if (urlObj.hostname === "generativelanguage.googleapis.com") {
      return "google";
    }
  } catch (e) {
    // ignore
  }
  return "openai";
}

export function getChatCompletionUrl(baseUrl, format) {
  let uri = baseUrl || "https://generativelanguage.googleapis.com/v1beta/openai";
  try {
    const urlObj = new URL(uri);
    const isGoogle = format === "google" || urlObj.hostname.includes("generativelanguage.googleapis.com");
    if (isGoogle) {
      if (!urlObj.pathname.endsWith("/openai")) {
        urlObj.pathname = urlObj.pathname.replace(/\/$/, "") + "/openai";
      }
    }
    urlObj.pathname = urlObj.pathname.replace(/\/$/, "") + "/chat/completions";
    return urlObj.toString();
  } catch (e) {
    // Fallback if URL parsing fails
    return `${uri.replace(/\/$/, "")}/chat/completions`;
  }
}

export function getEmbeddingUrl(baseUrl, modelName, apiKey, format) {
  let uri = baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  try {
    const urlObj = new URL(uri);
    const isGoogle = format === "google" || urlObj.hostname.includes("generativelanguage.googleapis.com");
    if (isGoogle) {
      urlObj.pathname = urlObj.pathname.replace(/\/openai\/?$/, "");
      const cleanModelName = modelName.replace(/^models\//, "");
      urlObj.pathname = `${urlObj.pathname.replace(/\/$/, "")}/models/${cleanModelName}:batchEmbedContents`;
      urlObj.searchParams.set("key", (apiKey || "").trim());
      return urlObj.toString();
    } else {
      urlObj.pathname = urlObj.pathname.replace(/\/$/, "") + "/embeddings";
      return urlObj.toString();
    }
  } catch (e) {
    return `${uri.replace(/\/$/, "")}/embeddings`;
  }
}

export async function fetchEmbeddingAPI(expertConfig, texts, taskType, signal = null) {
  const url = getEmbeddingUrl(expertConfig.baseUrl, expertConfig.model, expertConfig.apiKey, expertConfig.format);
  const isGoogleHost = (expertConfig.baseUrl || "").includes("generativelanguage.googleapis.com");
  const isGoogleFormat = expertConfig.format === "google" || isGoogleHost;
  
  let requestBody;
  let headers = { "Content-Type": "application/json" };
  
  const cleanApiKey = (expertConfig.apiKey || "").trim();
  
  if (isGoogleFormat) {
    const modelName = expertConfig.model.replace(/^models\//, "");
    const requests = texts.map((text) => {
        const req = {
          model: `models/${modelName}`,
          content: { parts: [{ text }] },
          taskType: taskType || expertConfig.taskType || "RETRIEVAL_DOCUMENT"
        };
        req.outputDimensionality = 768;
        return req;
    });
    requestBody = JSON.stringify({ requests });
  } else {
    headers["Authorization"] = `Bearer ${cleanApiKey}`;
    headers["api-key"] = cleanApiKey;
    
    const payload = {
        input: texts,
        model: expertConfig.model
    };
    payload.dimensions = 768;
    
    requestBody = JSON.stringify(payload);
  }

  return await fetch(url, {
    method: "POST",
    headers,
    body: requestBody,
    signal
  });
}

export async function parseEmbeddingResponse(response, format, baseUrl) {
  const data = await response.json();
  const isGoogleFormat = format === "google" || (baseUrl || "").includes("generativelanguage.googleapis.com");
  let embeddingsResult = [];
  if (isGoogleFormat) {
      embeddingsResult = data.embeddings.map((e) => e.values);
  } else {
      embeddingsResult = data.data.map((e) => e.embedding);
  }
  return embeddingsResult;
}

export function buildThinkingPayload(budget) {
  if (budget === -1 || budget === "-1" || budget === "auto") {
    return { type: "enabled" };
  }
  const numericBudget = Number(budget);
  if (!numericBudget || numericBudget === 0) return null;
  return { type: "enabled", budget_tokens: numericBudget };
}

export async function fetchChatCompletionAPI(expertConfig, messages, signal = null) {
  const url = getChatCompletionUrl(expertConfig.baseUrl, expertConfig.format);
  const cleanApiKey = (expertConfig.apiKey || "").trim();
  
  const capabilities = expertConfig.capabilities || {};

  // Handle systemRole capability - merge system instructions into first user message if system not supported
  let finalMessages = [...messages];
  if (!capabilities.systemRole) {
    const systemMessages = finalMessages.filter(m => m.role === 'system');
    finalMessages = finalMessages.filter(m => m.role !== 'system');
    if (systemMessages.length > 0 && finalMessages.length > 0) {
      finalMessages[0] = { 
        ...finalMessages[0], 
        content: `${systemMessages.map(m => m.content).join('\n\n')}\n\n${finalMessages[0].content}` 
      };
    } else if (systemMessages.length > 0) {
      finalMessages.unshift({ role: 'user', content: systemMessages.map(m => m.content).join('\n\n') });
    }
  }

  const payload = {
    model: expertConfig.model,
    messages: finalMessages,
    temperature: expertConfig.temperature !== undefined ? Number(expertConfig.temperature) : 0.7,
    top_p: expertConfig.topP !== undefined ? Number(expertConfig.topP) : 0.9,
    stream: !!expertConfig.stream
  };

  if (capabilities.topK) {
    const topK = Number(expertConfig.topK);
    if (topK > 0) {
      payload.top_k = topK;
    }
  }

  const maxTokens = Number(expertConfig.maxTokens);
  if (maxTokens > 0) {
    payload.max_tokens = maxTokens;
  }

  if (capabilities.thinking) {
    const thinking = buildThinkingPayload(expertConfig.thinkingBudget);
    if (thinking) {
      payload.thinking = thinking;
    }
  }

  if (capabilities.responseFormat && expertConfig.responseFormat) {
    payload.response_format = expertConfig.responseFormat;
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cleanApiKey}`
  };

  if (!url.includes("generativelanguage.googleapis.com")) {
    headers['api-key'] = cleanApiKey;
  }

  return await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal
  });
}

export async function fetchModelsListAPI(provider, apiKey) {
  const cleanApiKey = (apiKey || "").trim();
  
  let baseUrl = provider.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const isGoogleHost = baseUrl.includes("generativelanguage.googleapis.com");
  const isGoogleFormat = getProviderFormat(provider) === "google";
  
  const headers = {};
  let models = [];

  if (isGoogleFormat || isGoogleHost) {
    // Dù format parse là gì, nếu host là Google thì bắt buộc dùng đúng chuẩn Google models.list
    let uri = baseUrl;
    // Remove /openai or /models if user accidentally added them
    uri = uri.replace(/\/openai\/?$/, "");
    uri = uri.replace(/\/models\/?$/, "");
    uri = uri.replace(/\/$/, "");
    
    const baseRequestUrl = `${uri}/models`;
    headers['x-goog-api-key'] = cleanApiKey;

    // Google API Pagination
    let nextPageToken = null;
    do {
      const separator = baseRequestUrl.includes('?') ? '&' : '?';
      let fetchUrl = `${baseRequestUrl}${separator}pageSize=1000`;
      if (nextPageToken) {
        fetchUrl += `&pageToken=${encodeURIComponent(nextPageToken)}`;
      }

      const response = await fetch(fetchUrl, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      if (data.models && Array.isArray(data.models)) {
        models = models.concat(data.models.map(m => m.name.replace(/^models\//, '')));
      }
      nextPageToken = data.nextPageToken;
    } while (nextPageToken);

  } else {
    let uri = baseUrl;
    uri = uri.replace(/\/chat\/completions\/?$/, "");
    const fetchUrl = `${uri.replace(/\/$/, "")}/models`;
    
    headers['Content-Type'] = 'application/json';
    headers['Authorization'] = `Bearer ${cleanApiKey}`;
    // Some proxies prefer api-key header
    if (!fetchUrl.includes("generativelanguage.googleapis.com")) {
      headers['api-key'] = cleanApiKey;
    }

    const response = await fetch(fetchUrl, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    if (data.data && Array.isArray(data.data)) {
      models = data.data.map(m => m.id);
    }
  }
  
  const uniqueModels = [...new Set(models)];
  return uniqueModels.sort();
}
