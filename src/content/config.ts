import { defineCollection, z } from 'astro:content'

const articleSchema = z.object({
  title: z.string(),
  description: z.string(),
  publishDate: z.coerce.date(),
  order: z.number().int().positive(),
  tags: z.array(z.string()).optional(),
  readingTime: z.string().optional(),
})

const blogCollection = defineCollection({
  type: 'content',
  schema: articleSchema,
})

const extensionCollection = defineCollection({
  type: 'content',
  schema: articleSchema,
})

const performanceCollection = defineCollection({
  type: 'content',
  schema: articleSchema,
})

const securityCollection = defineCollection({
  type: 'content',
  schema: articleSchema,
})

const uxCollection = defineCollection({
  type: 'content',
  schema: articleSchema,
})

export const collections = {
  blog: blogCollection,
  extension: extensionCollection,
  performance: performanceCollection,
  security: securityCollection,
  ux: uxCollection,
}