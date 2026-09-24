/** Content script for https://chatgpt.com/* (see runtime.ts: passive, selected conversations only). */
import { extractChatGPT } from './extract-chatgpt.ts'
import { startInPage } from './runtime.ts'

startInPage('chatgpt', extractChatGPT)
