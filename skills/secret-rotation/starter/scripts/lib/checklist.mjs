// The options of the "what do you want to rotate" checklist. Everything is selected by
// default except what is slow, because a slow step stretches the whole rotation and the
// time until a failure is recovered, so it should be a choice. A slow group carries its
// time estimate as `warn`, which the checklist shows in red beside it.
export function buildChecklist(groups) {
  return groups.map((group) => ({
    id: group.id,
    label: group.title,
    hint: group.generate ? 'generated for you' : group.keys.join(', '),
    warn: group.slow,
    checked: !group.slow,
  }));
}
