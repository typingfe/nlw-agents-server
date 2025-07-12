import { and, eq, sql } from 'drizzle-orm'
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { db } from '../../db/connection.ts'
import { schema } from '../../db/schema/index.ts'
import { generateAnswer, generateEmbeddings } from '../../services/gemini.ts'

export const createQuestionRoute: FastifyPluginCallbackZod = (app) => {
    app.post(
        '/rooms/:roomId/questions',
        {
            schema: {
                params: z.object({
                    roomId: z.string(),
                }),
                body: z.object({
                    question: z.string().min(1, 'Question is required'),
                }),
            },
        },
        async ({ body, params }, reply) => {
            const { roomId } = params
            const { question } = body

            const embeddings = await generateEmbeddings(question)
            const embeddingAsString = `[${embeddings.join(',')}]`

            const chunks = await db
                .select({
                    id: schema.audioChunks.id,
                    transcription: schema.audioChunks.transcription,
                    similarity: sql<number>`1 - (${schema.audioChunks.embeddings} <=> ${embeddingAsString}::vector)`,
                })
                .from(schema.audioChunks)
                .where(
                    and(
                        eq(schema.audioChunks.roomId, roomId),
                        sql`1 - (${schema.audioChunks.embeddings} <=> ${embeddingAsString}::vector) > 0.7`
                    )
                )
                .orderBy(sql`${schema.audioChunks.embeddings} <=> ${embeddingAsString}::vector`)
                .limit(3)

            // biome-ignore lint/suspicious/noConsole: <test>
            console.log(chunks)

            let answer: string | null = null

            if (chunks.length > 0) {
                const transcriptions = chunks.map((chunk) => chunk.transcription)

                answer = await generateAnswer(question, transcriptions)
            }

            const result = await db
                .insert(schema.questions)
                .values({
                    roomId,
                    question,
                    answer,
                })
                .returning()

            const insertedQuestion = result[0]

            if (!insertedQuestion) {
                throw new Error('Failed to create a new question')
            }

            return reply.status(201).send({ questionId: insertedQuestion.id, answer })
        }
    )
}
