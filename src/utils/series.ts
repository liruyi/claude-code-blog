import { getCollection, type CollectionEntry } from 'astro:content'

export interface SeriesMeta {
  id: string
  title: string
  description: string
  color: string
  order: number
}

export const SERIES_CONFIG: Record<string, SeriesMeta> = {
  blog: {
    id: 'blog',
    title: 'Claude Code 源码分析',
    description: '深入探索 Anthropic 官方 CLI 工具的设计哲学',
    color: '#667eea',
    order: 1,
  },
  extension: {
    id: 'extension',
    title: 'Claude Code 扩展开发',
    description: 'Skills、Hooks、MCP 扩展开发实战指南',
    color: '#7c3aed',
    order: 2,
  },
  performance: {
    id: 'performance',
    title: 'Claude Code 性能优化',
    description: '从启动优化到内存管理的性能哲学',
    color: '#059669',
    order: 3,
  },
  security: {
    id: 'security',
    title: 'Claude Code 安全模型',
    description: '权限系统、沙箱执行与企业安全部署',
    color: '#dc2626',
    order: 4,
  },
  ux: {
    id: 'ux',
    title: 'Claude Code 终端 UX',
    description: '终端交互设计、响应式布局与用户体验',
    color: '#0891b2',
    order: 5,
  },
}

type ValidCollection = 'blog' | 'extension' | 'performance' | 'security' | 'ux'

export async function getAllArticles() {
  const [blog, extension, performance, security, ux] = await Promise.all([
    getCollection('blog'),
    getCollection('extension'),
    getCollection('performance'),
    getCollection('security'),
    getCollection('ux'),
  ])

  return [...blog, ...extension, ...performance, ...security, ...ux]
    .sort((a, b) => b.data.publishDate.valueOf() - a.data.publishDate.valueOf())
}

export async function getSeriesArticles(seriesId: ValidCollection) {
  const articles = await getCollection(seriesId)
  return articles.sort((a, b) => a.data.order - b.data.order)
}

export function getSeriesMeta(seriesId: string): SeriesMeta | undefined {
  return SERIES_CONFIG[seriesId]
}

export function getAllSeriesMeta(): SeriesMeta[] {
  return Object.values(SERIES_CONFIG).sort((a, b) => a.order - b.order)
}

export function isValidSeries(seriesId: string): seriesId is ValidCollection {
  return ['blog', 'extension', 'performance', 'security', 'ux'].includes(seriesId)
}