@echo off
set NODE_TLS_REJECT_UNAUTHORIZED=0
npx prisma init --db --output ../generated/prisma