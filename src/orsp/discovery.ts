import { openReadingRightsReportUrl } from './protocol.js';
import type { LegadoBookSource, UnsupportedFeatures } from '../legado/types.js';
import type { ExploreEntry } from '../legado/explore.js';

export function buildDiscoveryDocument(params: {
  id: string;
  origin: string;
  legado: LegadoBookSource;
  unsupported: UnsupportedFeatures;
  exploreEntries?: ExploreEntry[];
}) {
  const { id, origin, legado, unsupported, exploreEntries = [] } = params;
  const caveats: string[] = [];
  if (unsupported.cookieMode === 'browser-unsupported') {
    caveats.push('配置包含浏览器/WebView/人机验证流程，服务端不执行；当前可用性以完整链路健康验证为准');
  } else if (unsupported.cookieMode === 'interactive-unsupported') {
    caveats.push('配置包含交互式登录流程，服务端不代登；当前可用性以完整链路健康验证为准');
  } else if (unsupported.cookieMode === 'http-session') {
    caveats.push('使用普通 HTTP Cookie 会话，由适配器在内存中维护');
  } else if (unsupported.cookieMode === 'static') {
    caveats.push('使用书源静态 Cookie 请求头');
  }
  if (unsupported.embeddedJs) {
    caveats.push('规则包含内嵌 JS / java.*（服务端不执行，相关字段可能为空）');
  }
  if (unsupported.humanVerification) {
    caveats.push('原书源依赖人机验证/Cloudflare（服务端不会尝试绕过）');
  }
  caveats.push('上游站点若屏蔽本服务器所在网络，接口会返回 UNAVAILABLE');

  return {
    protocol: 'open-reading-source',
    protocolVersion: '1.4',
    id,
    name: `${legado.bookSourceName}（ORSP 转换）`,
    description: [
      `由书源规则自动转换生成，抓取自第三方站点 ${legado.bookSourceUrl}。`,
      caveats.length ? `已知限制：${caveats.join('；')}。` : '',
    ]
      .filter(Boolean)
      .join(' '),
    apiBaseUrl: `${origin}/s/${id}/api/`,
    websiteUrl: legado.bookSourceUrl,
    languages: ['zh-CN'],
    supportedVersions: ['1.4'],
    maxCatalogPageSize: 200,
    capabilities: [
      'search',
      ...(exploreEntries.length > 0 ? ['discover', 'categories', 'browse'] : []),
      'detail',
      'catalog',
      'content',
    ],
    operatorName: 'ORSP Converter community instance',
    contactUrl: openReadingRightsReportUrl,
    contentLicense: 'Unknown / third-party — see rightsStatement',
    rightsStatement:
      '本项目只提供第三方规则的格式转换，不提供书籍内容或书源，不对内容的合法性、授权、准确性或持续可用性作任何认定或担保，' +
      '亦不代表该内容已获授权分发。使用者必须确认自己具有合法访问和使用权限，并在个人测试后尽快删除临时获取或缓存的内容。' +
      '版权相关诉求请联系该书源根地址所指向的原站运营者或权利人，或通过下方 contactUrl 申请人工封禁或下架。',
  };
}
