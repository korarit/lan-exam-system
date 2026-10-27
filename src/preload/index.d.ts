import type { ZtExamApi } from '@shared/api'

declare global {
  interface Window {
    ztExam: ZtExamApi
  }
}

export {}
