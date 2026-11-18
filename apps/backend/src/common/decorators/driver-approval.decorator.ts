import { SetMetadata } from '@nestjs/common';

export const REQUIRE_DRIVER_APPROVAL_KEY = 'requireDriverApproval';
export const RequireDriverApproval = () => SetMetadata(REQUIRE_DRIVER_APPROVAL_KEY, true);
