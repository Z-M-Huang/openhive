---
paths:
  - "web/src/**/*.{ts,tsx}"
---

# Frontend Rules

- React 18 + Vite 6 + TanStack Query 5 + clsx + tailwind-merge + lucide-react
- No AI logic in frontend — the web portal is monitoring-only
- Use TanStack Query for all data fetching (`useQuery`/`useMutation`)
- Functional components with hooks — no class components
- Use `clsx` + `tailwind-merge` for conditional class names
- Use lucide-react for icons
- Type all props with TypeScript interfaces — no `any`
- No direct DOM manipulation — use React refs when needed
- Keep components small and focused — extract hooks for complex logic
