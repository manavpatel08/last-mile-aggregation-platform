import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class WaiveCancellationFeeDto {
  @IsString({ message: 'waiverReason must be a string' })
  @IsNotEmpty({ message: 'waiverReason must not be empty' })
  @MaxLength(500, { message: 'waiverReason must not exceed 500 characters' })
  waiverReason!: string;
}
