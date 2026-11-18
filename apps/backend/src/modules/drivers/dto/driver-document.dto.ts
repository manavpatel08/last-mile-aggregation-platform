import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class DriverDocumentDto {
  @IsString()
  @IsIn(['DRIVING_LICENSE', 'VEHICLE_RC', 'VEHICLE_INSURANCE'])
  documentType!: string;

  @IsString()
  @IsNotEmpty()
  documentUrl!: string;
}
