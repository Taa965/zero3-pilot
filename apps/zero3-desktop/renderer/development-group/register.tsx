import { ROUTES_AREA, SIDEBAR_NAV_AREA, type RouteContribution, type SidebarNavContribution } from '@/app/routes'
import { registry } from '@/contrib/registry'

import { DevelopmentGroupPage } from './page'

export const ZERO3_DEVELOPMENT_GROUP_ROUTE = '/development-groups'

registry.registerMany([
  {
    id: 'zero3-development-groups-page',
    area: ROUTES_AREA,
    source: 'zero3',
    title: '开发组',
    data: { path: ZERO3_DEVELOPMENT_GROUP_ROUTE } satisfies RouteContribution,
    render: () => <DevelopmentGroupPage />
  },
  {
    id: 'zero3-development-groups-nav',
    area: SIDEBAR_NAV_AREA,
    source: 'zero3',
    order: 45,
    data: { codicon: 'organization', label: '开发组', path: ZERO3_DEVELOPMENT_GROUP_ROUTE } satisfies SidebarNavContribution
  }
])
