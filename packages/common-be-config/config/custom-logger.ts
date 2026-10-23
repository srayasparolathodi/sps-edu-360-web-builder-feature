import {
  Injectable,
  ConsoleLogger,
  LogLevel,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Optional,
} from '@nestjs/common'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as winston from 'winston'
import { ElasticsearchTransport, LogData } from 'winston-elasticsearch'
import DailyRotateFile from 'winston-daily-rotate-file'
import { RequestContext } from '../providers/request-context'

interface CustomLoggerOptions {
  appName?: string
  currentExecutor?: string
}

@Injectable()
export class CustomLogger extends ConsoleLogger {
  private static appName: string = ''
  private currentExecutor: string = ''
  private logger: winston.Logger
  constructor(@Optional() context?: CustomLoggerOptions) {
    super(
      `${CustomLogger.appName}${context?.currentExecutor ? ` - ${context.currentExecutor}` : ''}`,
    )
    this.currentExecutor = context?.currentExecutor ?? this.currentExecutor

    const customFormat = winston.format.combine(
      winston.format.timestamp({ format: 'DD/MM/YYYY, hh:mm:sss a' }), // Timestamp format
      winston.format.json(),
      winston.format.printf(({ timestamp, level, message }) => {
        const context = RequestContext.get()
        const ridInfo = context?.rid ? `mdc-token:${context.rid}` : ''
        const userInfo = context?.email
          ? `User:${context.email}`
          : 'User:anonymous'
        const apiPathInfo = context?.apiPath ? `path:${context.apiPath}` : ''
        const ipAddressInfo = context?.ipAddress
          ? `Ip-Address:${context.ipAddress}`
          : ''
        const userAgentInfo = context?.userAgent
          ? `UserAgent:${context.userAgent}`
          : ''
        return `${timestamp} ${level.toUpperCase()} [Nest] ${process.pid} - ${CustomLogger.appName ? `[${CustomLogger.appName}]` : ''} ${this.currentExecutor ? `[${this.currentExecutor}]` : ''} ${userAgentInfo ? ` ${userAgentInfo} ` : ''} ${ipAddressInfo ? ` ${ipAddressInfo} ` : ''} ${ridInfo ? ` ${ridInfo} ` : ''}${userInfo ? `${userInfo} ` : ''}${apiPathInfo ? `${apiPathInfo} ` : ''} ${message}` // Custom format
      }),
    )

    // Initialize Elasticsearch transport
    const esTransport = new ElasticsearchTransport({
      level: 'info',
      clientOpts: {
        node: process.env.ELASTIC_URL || 'http://localhost:9200',
        auth: {
          username: 'elastic',
          password: 'changeme',
        },
      },
      indexPrefix: `${CustomLogger.appName.toLowerCase()}-logs`,
      useTransformer: true,
      transformer: (logData: LogData) => {
        const context = RequestContext.get()
        return {
          level: logData.level.toUpperCase(),
          message: logData.message,
          timestamp: logData.timestamp || new Date().toISOString(),
          meta: {
            appName: CustomLogger.appName,
            currentExecutor: this.currentExecutor,
            rid: context?.rid,
            user: context?.email,
            apiPath: context?.apiPath,
            ipAddress: context?.ipAddress,
            userAgent: context?.userAgent,
          },
        }
      },
    })
    // Initialize file rotation transport
    const rotateTransport = new DailyRotateFile({
      filename: `logs/${CustomLogger.appName}-application-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true, // Compress rotated logs
      maxSize: '20m', // Max log file size
      maxFiles: '2d', // Retain logs for 14 days
      level: 'info', // Log only 'info' and above levels (info, warn, error)
      format: customFormat,
    })

    // Create the winston logger instance
    this.logger = winston.createLogger({
      transports: [
        new winston.transports.Console({
          level: 'debug',
          format: customFormat,
        }),
        esTransport,
        rotateTransport,
      ],
    })
  }
  // Log a message with context
  override log(messages: any, ...optionalParams: [...any, string?]) {
    const formattedMessage = this.customFormatMessage()

    this.logger.info(
      `${formattedMessage} | ${JSON.stringify(messages)}`,
      ...optionalParams,
    )
  }

  // Log an error with context
  override error(messages: any, ...optionalParams: [...any, string?]) {
    const formattedMessage = this.customFormatMessage()
    this.logger.error(
      `${formattedMessage} | ${JSON.stringify(messages)}`,
      ...optionalParams,
    )
  }

  // Log a warning with context
  override warn(messages: any, ...optionalParams: [...any, string?]) {
    const formattedMessage = this.customFormatMessage()
    this.logger.warn(
      `${formattedMessage} | ${JSON.stringify(messages)}`,
      ...optionalParams,
    )
  }

  // Log a debug message with context
  override debug(messages: any, ...optionalParams: [...any, string?]) {
    const formattedMessage = this.customFormatMessage()
    this.logger.debug(
      `${formattedMessage} | ${JSON.stringify(messages)}`,
      ...optionalParams,
    )
  }

  // Log a verbose message with context
  override verbose(messages: any, ...optionalParams: [...any, string?]) {
    const formattedMessage = this.customFormatMessage()
    this.logger.verbose(
      `${formattedMessage} | ${JSON.stringify(messages)}`,
      ...optionalParams,
    )
  }

  static setAppName(appName: string) {
    CustomLogger.appName = appName
  }

  // Helper to get the current context (rid, email)

  private customFormatMessage(): string {
    const context = RequestContext.get()
    return [
      `mdc-token:${context?.rid}`,
      context?.email ? `User:${context.email}` : 'User:anonymous',
      context?.apiPath ? `Api:${context.apiPath}` : '',
      context?.userAgent ? `UserAgent:${context.userAgent}` : '',
      context?.ipAddress ? `Ip-Address:${context.ipAddress}` : '',
    ]
      .filter(Boolean)
      .join(' | ')
  }
}
