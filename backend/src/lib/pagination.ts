/** Shared list-endpoint pagination (?page&limit&search&sort). */

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

export function parsePagination(query: Record<string, any>): Pagination {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(query.limit ?? '20'), 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
}

export function paginatedResponse<T>(items: T[], total: number, { page, limit }: Pagination): Paginated<T> {
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}
