import { IsBoolean, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateDriverStatusDto {
  @Type(() => Object)
  @IsBoolean({ message: 'isOnline must be a boolean' })
  @IsNotEmpty()
  isOnline!: boolean;
}
