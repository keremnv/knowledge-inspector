import type { Route } from "@playwright/test";

// Ordinary fixture without an external reader declaration.
export class FixtureWorld {
  count = 3;
  hub = false;
  id = "review";
  private gates = new Map<string, { reached: () => void; released: Promise<void>; release: () => void }>();

  block(key: string) {
    let reached!: () => void;
    let release!: () => void;
    const requested = new Promise<void>((done) => { reached = done; });
    const released = new Promise<void>((done) => { release = done; });
    this.gates.set(key, { reached, released, release });
    return { requested, release };
  }

  releaseAll() {
    for (const gate of this.gates.values()) gate.release();
  }

  get roles() {
    return [
      { name: "item", type: "REFERENT", referent: true, kinds: ["entity"] },
      { name: "peer", type: "REFERENT", referent: true, kinds: ["entity"] },
      { name: "value", type: "TEXT", referent: false },
    ];
  }

  tuples() {
    return Array.from({ length: this.count }, (_, i) => ({
      assertion_id: `assertion:${i}`, origin: "SEMANTIC", origins: ["SEMANTIC"],
      values: { item: `entity:${this.hub ? 0 : i}`, peer: `entity:${i + 1}`, value: `value-${i}` },
    }));
  }

  async respond(route: Route) {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/world/")) return route.continue();
    const name = url.pathname.slice("/world/".length);
    const id = url.searchParams.get("id") ?? "";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const gate = this.gates.get(name === "rows" ? `rows:${offset}` : name);
    if (gate) {
      gate.reached();
      await gate.released;
    }
    const relation = {
      name: "property", description: "Fixture property", mode: "BASE", arity: 3, referent_arity: 2,
      roles: this.roles, count: this.count, stale: false, origins: ["SEMANTIC"], scope: "WORLD", completeness: null,
    };
    let answer: unknown;
    switch (name) {
      case "overview":
        answer = {
          world_id: this.id, revision: 1, relations: 1, referents: this.count + 1, assertions: this.count,
          origins: { SEMANTIC: this.count }, stale: [], incomplete: [],
          demand: { purpose: { statement: "fixture" }, obligations: 0, demanded: 0 },
          governed_obligations: { count: 0, resolved: 0, unresolved: 0 },
        };
        break;
      case "schema": answer = { relations: [relation] }; break;
      case "referents":
        answer = {
          referents: Array.from({ length: this.count + 1 }, (_, i) => ({ id: `entity:${i}`, label: `Entity ${i}` })),
          total: this.count + 1, truncated: false,
        };
        break;
      case "rows": {
        const subject = url.searchParams.get("subject");
        const rows = this.tuples().filter((tuple) => !subject || Object.values(tuple.values).includes(subject));
        answer = {
          relation: "property", mode: "BASE", stale: false, roles: this.roles, offset, total: rows.length,
          rows: rows.slice(offset, offset + Number(url.searchParams.get("limit") ?? 200)),
        };
        break;
      }
      case "assertion": {
        const tuple = this.tuples().find((item) => item.assertion_id === id)!;
        answer = {
          ...tuple, relation: "property", mode: "BASE", arity: 3, roles: this.roles,
          assertion_state: "ASSERTED", created_revision: 1, relation_stale: false, completeness: null,
          grounding: [], commitment_id: id, candidate_for: [], governing_obligations: [], candidate_assessments: [],
          warrant: {
            commitment_id: id, relation: "property", assertion_origin: "SEMANTIC",
            recorded_construction_origin: "SEMANTIC", construction_origins: ["SEMANTIC"], created_revision: 1, bases: [],
          },
        };
        break;
      }
      case "referent":
        answer = {
          id, label: `Entity ${id.split(":")[1]}`, grounding: [],
          fields: this.tuples().filter((tuple) => Object.values(tuple.values).includes(id)).map((tuple) => ({
            relation: 'property', role: 'value', value: tuple.values.value,
            assertion_id: tuple.assertion_id, origin: 'SEMANTIC', referent_roles: ['item'],
          })),
          relations: [{
            name: "property", arity: 3, mode: "BASE", stale: false,
            count: this.tuples().filter((tuple) => Object.values(tuple.values).includes(id)).length,
          }],
        };
        break;
      case "demand":
        answer = { demand: { purpose: { statement: "fixture" }, rule: null, demanded: 0, obligations: [] } };
        break;
      case "obligations": answer = { obligations: [] }; break;
      default: return route.fulfill({ status: 404, json: { error: `Unexpected fixture read: ${url}` } });
    }
    return route.fulfill({ json: answer });
  }
}
