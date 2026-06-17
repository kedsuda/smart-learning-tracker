import axios, { AxiosInstance } from 'axios';
import { getStoredUserId } from '../constants/storage';

const normalizeBaseURL = (value?: string | null) => {
  if (!value) return '';
  return value.replace(/\/$/, '');
};

const ensureAbsolutePath = (value: string) => {
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return value.startsWith('/') ? value : `/${value}`;
};

const toApiBaseURL = (value: string) => {
  const trimmed = ensureAbsolutePath(value.replace(/\/$/, ''));
  if (trimmed.endsWith('/api')) return trimmed;
  if (trimmed.endsWith('/public')) return `${trimmed}/index.php/api`;
  if (trimmed.endsWith('/public/index.php') || trimmed.endsWith('/index.php')) {
    return `${trimmed}/api`;
  }
  return `${trimmed}/api`;
};

const isLoopbackURL = (value?: string | null) => {
  if (!value) return false;
  try {
    const parsed = new URL(value, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
};

const rawBaseURL = import.meta.env.VITE_API_URL?.trim();
const resolvedBaseURL = rawBaseURL ? toApiBaseURL(rawBaseURL) : '';
const directProxyTarget = import.meta.env.VITE_API_PROXY_TARGET?.trim();
const directBaseURL = directProxyTarget ? toApiBaseURL(directProxyTarget) : '';
const rawLegacyProxyTarget = import.meta.env.VITE_LEGACY_PROXY_TARGET?.trim();
const isLocalhost =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

const detectLocalProjectPrefix = () => {
  if (typeof window === 'undefined') return '';
  const pathname = window.location.pathname || '/';
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const first = segments[0];
  const appRootMarkers = new Set([
    'auth',
    'login',
    'admin',
    'admin.php',
    'admin_login.php',
    'admin_logout.php',
    'subjects',
    'quizzes',
    'calendar',
    'notifications',
    'profile',
    'goals',
    'voice-summary',
    'document-summary',
    'career-advisor',
    'overview',
    'study-capture',
    'study-digest',
    'ai-assistant',
    'study-storage',
    'public',
    'backend',
    'api',
  ]);
  return appRootMarkers.has(first) ? '' : `/${first}`;
};

const isViteDevPort =
  typeof window !== 'undefined' && /^517\d$/.test(window.location.port || '');
const localProjectPrefix = isViteDevPort ? '' : detectLocalProjectPrefix();
const shouldUseResolvedBaseOnLocalhost = (() => {
  if (!isLocalhost || !resolvedBaseURL) return true;
  if (typeof window === 'undefined') return true;

  try {
    const resolvedUrl = new URL(resolvedBaseURL, window.location.origin);
    return resolvedUrl.origin === window.location.origin;
  } catch {
    return true;
  }
})();

const localhostProxyBaseURL = `${localProjectPrefix}/api`;
const localhostApacheBaseURL = `${localProjectPrefix}/public/index.php/api`;
const localhostDefaultBaseURL = isViteDevPort ? localhostProxyBaseURL : localhostApacheBaseURL;
const shouldUseSameOriginApi =
  !isLocalhost &&
  (isLoopbackURL(resolvedBaseURL) || !resolvedBaseURL);
const baseURL =
  shouldUseSameOriginApi
    ? '/api'
    : isLocalhost && !shouldUseResolvedBaseOnLocalhost
    ? localhostDefaultBaseURL
    : resolvedBaseURL || (isLocalhost ? localhostDefaultBaseURL : '/api');
const proxyTarget = directProxyTarget;
const proxyAssetBase = proxyTarget
  ? normalizeBaseURL(proxyTarget.replace(/\/index\.php\/?$/, '').replace(/\/api\/?$/, ''))
  : '';
const assetBaseURL =
  normalizeBaseURL(import.meta.env.VITE_ASSET_URL?.trim()) ||
  normalizeBaseURL(rawBaseURL?.replace(/\/api\/?$/, '')) ||
  (isLocalhost
    ? (isViteDevPort && proxyAssetBase ? proxyAssetBase : `${localProjectPrefix}/public`)
    : proxyAssetBase);

export const api = axios.create({
  baseURL,
  withCredentials: false,
});

export { assetBaseURL };

const legacyBaseURL = !isLocalhost && rawLegacyProxyTarget ? '/legacy-api/api' : '';
export const legacyApi = axios.create({
  baseURL: legacyBaseURL || baseURL,
  withCredentials: false,
});
export const directApi = directBaseURL
  ? axios.create({
      baseURL: directBaseURL,
      withCredentials: false,
    })
  : null;

const filterCollectionByUserId = (items: unknown[], userId: number) => {
  if (!items.length) return items;
  const allHaveUserId = items.every(
    item => item && typeof item === 'object' && 'user_id' in (item as Record<string, unknown>)
  );
  if (!allHaveUserId) return items;
  return items.filter(item => {
    const rawId = (item as Record<string, unknown>).user_id;
    const parsedId = typeof rawId === 'string' ? Number(rawId) : (rawId as number | null);
    return Number.isFinite(parsedId) && parsedId === userId;
  });
};

const filterResponseByUserId = (data: any) => {
  const userId = getStoredUserId();
  if (!userId) return data;
  if (Array.isArray(data)) {
    return filterCollectionByUserId(data, userId);
  }
  if (data && typeof data === 'object' && Array.isArray(data.data)) {
    return { ...data, data: filterCollectionByUserId(data.data, userId) };
  }
  return data;
};

const attachAuthInterceptors = (instance: AxiosInstance) => {
  instance.interceptors.request.use(config => {
    const token = localStorage.getItem('token');

    config.headers = config.headers ?? {};

    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    } else {
      // ✅ สำคัญ: กันสลับบัญชีแล้วค้าง header เก่า
      delete (config.headers as any).Authorization;
    }

    return config;
  });

  
  instance.interceptors.response.use(
    response => {
      response.data = filterResponseByUserId(response.data);
      return response;
    },
    error => Promise.reject(error)
  );
};

attachAuthInterceptors(api);
attachAuthInterceptors(legacyApi);
if (directApi) {
  attachAuthInterceptors(directApi);
}

const canUseDirectApi = Boolean(directApi) && !isLocalhost;
const fallbackCandidates = canUseDirectApi ? [api, directApi, legacyApi] : [api, legacyApi];
export const apiFallbackClients = fallbackCandidates.filter(
  (client): client is AxiosInstance => Boolean(client)
);
