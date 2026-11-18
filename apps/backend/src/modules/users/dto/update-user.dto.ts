import { IsIn, IsInt, IsOptional } from 'class-validator';

export class UpdateUserDto {
  @IsInt()
  @IsIn([2, 3, 4], { message: 'defaultMinGroupPreference must be 2, 3, or 4' })
  @IsOptional()
  defaultMinGroupPreference?: number;
}
