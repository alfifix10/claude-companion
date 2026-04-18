<!--
Thanks for sending a PR. Please keep it focused — one logical change per PR
makes review faster and reverts safer.
-->

### What and why

<!-- One paragraph: what does this PR change and why is it worth merging? -->

### Adversarial review

<!-- For non-trivial changes (see CONTRIBUTING.md), list the failure modes you
considered. Three is a good target. -->

1.
2.
3.

### Test evidence

<!-- How did you verify this works? Screenshots, GIFs, or console output. -->

- [ ] Reloaded the extension and ran at least one real prompt end-to-end.
- [ ] If this touches cancellation / timeouts / tab locking, I tested a disconnect scenario.
- [ ] If this touches security-sensitive code (tool allowlist, TCP handshake, Markdown rendering, payload parsing), I flagged the section in the description above.

### Checklist

- [ ] CI is green (`node --check` on all `.js`, `manifest.json` valid, docs present).
- [ ] No new dependencies, or each new dependency is justified.
- [ ] No new permissions, or each new permission is justified.
- [ ] I did not commit `.extension-private-key.pem` or anything under `host/node_modules/`.
