import type { Zero3CapabilityDefinition, Zero3CapabilityHandler } from './contracts.ts'

type RegisteredCapability = {
  definition: Zero3CapabilityDefinition
  handler: Zero3CapabilityHandler
}

function validateCapabilityId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) throw new Error(`invalid Zero3 capability id: ${value}`)
}

export class Zero3CapabilityRegistry {
  private readonly entries = new Map<string, RegisteredCapability>()

  register(definition: Zero3CapabilityDefinition, handler: Zero3CapabilityHandler): void {
    validateCapabilityId(definition.id)
    if (this.entries.has(definition.id)) throw new Error(`Zero3 capability is already registered: ${definition.id}`)
    this.entries.set(definition.id, { definition: structuredClone(definition), handler })
  }

  list(): Zero3CapabilityDefinition[] {
    return [...this.entries.values()]
      .map(entry => structuredClone(entry.definition))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  describe(id: string): Zero3CapabilityDefinition | null {
    validateCapabilityId(id)
    const entry = this.entries.get(id)
    return entry ? structuredClone(entry.definition) : null
  }

  handler(id: string): Zero3CapabilityHandler | null {
    validateCapabilityId(id)
    return this.entries.get(id)?.handler ?? null
  }
}
