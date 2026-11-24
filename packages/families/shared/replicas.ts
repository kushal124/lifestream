
export interface Chosen<R> {
  chosen: R;
  others: R[];
}

export interface ReplicaRule<R> {
  same(replica: R): string;
  prefer?(left: R, right: R): number;
  id(replica: R): string;
}

export function chooseReplicas<R>(replicas: Iterable<R>, rule: ReplicaRule<NoInfer<R>>): Chosen<R>[] {
  const groups = new Map<string, R[]>();
  for (const replica of replicas) {
    const key = rule.same(replica);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [replica]);
    else group.push(replica);
  }
  return [...groups].sort(([left], [right]) => compare(left, right)).map(([, group]) => {
    const ranked = group.sort((left, right) => (rule.prefer?.(left, right) ?? 0) || compare(rule.id(left), rule.id(right)));
    return { chosen: ranked[0]!, others: ranked.slice(1) };
  });
}

export function bySourceOrder(order: readonly string[]): (left: { source: string }, right: { source: string }) => number {
  const rank = (replica: { source: string }) => {
    const index = order.indexOf(replica.source);
    return index < 0 ? order.length : index;
  };
  return (left, right) => rank(left) - rank(right);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
