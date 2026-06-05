# factory-skills docs

This directory contains durable architecture and operating documentation for `factory-skills`.

`factory-skills` is the cognitive toolkit over Factory Memory. It is used by agents and by FactoryOS, but it is not itself FactoryOS. Architecture decisions in this directory define how the toolkit should evolve without collapsing Factory, Factory Skills, FactoryOS, clients, projects, and source-lineage tools into one flat concept.

## Index

- [ADR-0001: Factory Knowledge Architecture](adr/ADR-0001-factory-knowledge-architecture.md)

## Conventions

- Architecture decisions live under `docs/adr/`.
- ADRs are durable records, not task trackers.
- Status values are `proposed`, `accepted`, or `superseded`.
- Registry and neuron-scope changes should reference the relevant ADR before changing runtime behavior.
