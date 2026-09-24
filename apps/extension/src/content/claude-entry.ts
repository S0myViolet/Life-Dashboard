/** Content script for https://claude.ai/* (see runtime.ts: passive, selected conversations only). */
import { extractClaude } from './extract-claude.ts'
import { startInPage } from './runtime.ts'

startInPage('claude', extractClaude)
