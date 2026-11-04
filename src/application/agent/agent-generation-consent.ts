// Reuse only the strict client-consent format; the saved generation authority is always separate.
export {
    DEFAULT_AGENT_AUTHORING_CONSENT as DEFAULT_AGENT_GENERATION_CONSENT,
    normalizeAgentAuthoringConsent as normalizeAgentGenerationConsent,
    hasAgentAuthoringConsent as hasAgentGenerationConsent,
    updateAgentAuthoringConsent as updateAgentGenerationConsent,
} from './agent-authoring-consent'
export type { AgentAuthoringConsent as AgentGenerationConsent } from './agent-authoring-consent'
