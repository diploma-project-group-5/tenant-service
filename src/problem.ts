// Помилки у форматі application/problem+json (розділ 07): type, title, status, detail, code.
import type { FastifyReply } from 'fastify';

export type ProblemCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'login_taken'
  | 'internal';

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
}

export function problem(status: number, code: ProblemCode, title: string, detail?: string): Problem {
  return { type: `urn:lad:problem:${code}`, title, status, code, ...(detail ? { detail } : {}) };
}

export function sendProblem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).type('application/problem+json').send(p);
}
