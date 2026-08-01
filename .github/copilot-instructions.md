# ai-protocol-landing — Copilot instructions

Purpose: Give AI coding agents the essential, actionable knowledge to be productive in this repo.

Big picture
- Landing page for the AIxKer project, introducing the AI-native distributed kernel.
- Static HTML/CSS/JS site for project presentation and documentation.
- Part of the AIxKer ecosystem marketing and information materials.

Key files & where to look
- index.html: Main landing page with project introduction
- README.md: Brief description of the landing page
- CNAME: GitHub Pages custom domain configuration

Build & run (reproducible commands)
- Open index.html in browser: `firefox index.html` or similar
- Serve locally: `python -m http.server` then visit localhost:8000

Project-specific conventions (do not change silently)
- Dark mode default with light mode toggle
- Responsive design with mobile-first approach
- Custom fonts: Inter and JetBrains Mono
- Color scheme: Dark theme with cyan accents

Integration points & expectations
- Hosted on GitHub Pages
- Links to other AIxKer repositories
- Contains project architecture diagrams

Safe edits checklist for feature changes
- When updating content: Check both dark and light mode styles
- When adding sections: Maintain responsive grid layout
- When changing colors: Update CSS variables for both themes

Quick debugging tips
- Test in multiple browsers for CSS compatibility
- Check mobile responsiveness with browser dev tools
- Verify dark/light mode toggle functionality</content>
<parameter name="filePath">/media/elpixeler/Develop/Projects/AION/ai-protocol-landing/.github/copilot-instructions.md