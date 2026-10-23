import { SidebarTrigger, useSidebar } from '../../atoms/sidebar'
import { Separator } from '../../atoms/separator'
import SearchBar from './search-bar'
import ThemeSwitcher from '../theme-switcher/theme-switcher'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../../atoms/breadcrumb'

const NavBar = () => {
  const { isMobile } = useSidebar()

  return (
    <header className="flex w-full z-10 h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12 pr-3">
      <div className="flex w-full items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem className="hidden md:block">
              <BreadcrumbLink href="#">
                Building Your Application
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
            <BreadcrumbItem>
              <BreadcrumbPage>Data Fetching</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {!isMobile && (
        <div className="w-full max-w-[35%] flex items-center justify-between gap-4 flex-wrap">
          <SearchBar />
        </div>
      )}

      <div className="flex w-full flex-wrap gap-4 items-center justify-end content-end">
        <ThemeSwitcher />
      </div>
    </header>
  )
}

export default NavBar
