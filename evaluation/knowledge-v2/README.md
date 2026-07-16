# Knowledge V2 Retrieval Evaluation

`cases.jsonl` is a versioned, executable public-fixture evaluation suite. Each case must declare a retrieval category and source.

Fixture cases use `source: "fixture"`. A real feedback case may be added only after a workspace administrator has confirmed that it is useful for retrieval evaluation and removed personal, credential, customer, repository-secret, and other sensitive content. Such a case must use `source: "admin-approved-sanitized-feedback"` and must remain manually reviewable in the Git history.

The suite deliberately includes two projects. A case is always evaluated only against its declared project; cross-project coverage must never weaken project access filtering in runtime search.
