/** Token bucket is deliberately process-local; deployments should also rate-limit at the proxy. */
export function rateLimit() {
  const users = new Map<number, { start: number; count: number }>();
  return (id: number) => {
    const now = Date.now();
    if (users.size >= 10000)
      for (const [key, value] of users)
        if (now - value.start > 60000) users.delete(key);
    let value = users.get(id);
    if (!value || now - value.start > 60000) {
      if (users.size >= 10000 && !value) return false;
      value = { start: now, count: 0 };
      users.set(id, value);
    }
    return ++value.count <= 90;
  };
}
