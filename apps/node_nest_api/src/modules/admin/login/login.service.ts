import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isEmpty } from 'lodash';
import { ImageCaptchaDto } from './login.dto';
import * as svgCaptcha from 'svg-captcha';
import { ApiException } from '@/common/exceptions/api.exception';
import { SysUserService } from '../system/user/user.service';
import SysUser from '@/entities/admin/sys_user.entity';
import { UtilService } from '@/shared/services/util.service';
import { SysMenuService } from '../system/menu/menu.service';
import { RedisService } from '@/shared/redis/redis.service';
import { SysLogService } from '../system/log/log.service';

@Injectable()
export class LoginService {
	constructor(
		private redisService : RedisService,

		private userService : SysUserService,
		private menuService : SysMenuService,
		private util : UtilService,
		private jwtService : JwtService,
		private logService : SysLogService,
	) { }

	// redis connect test
	async redisTest() {
		return await this.redisService.getAllKeys();
	}

	/**
	 * 创建验证码并缓存加入redis缓存
	 * @param captcha 验证码长宽
	 * @returns svg & id obj
	 */
	async createImageCaptcha(captcha : ImageCaptchaDto) {
		const svg = svgCaptcha.create({
			size: 4,
			color: true,
			noise: 4,
			width: isEmpty(captcha.width) ? 100 : captcha.width,
			height: isEmpty(captcha.height) ? 50 : captcha.height,
			charPreset: '1234567890',
		});
		const result = {
			img: `data:image/svg+xml;base64,${Buffer.from(svg.data).toString(
				'base64',
			)}`,
			id: this.util.generateUUID(),
		};

		// 5分钟过期时间
		await this.redisService.set(`admin:captcha:img:${result.id}`, svg.text, 60 * 5);

		return result
	}

	/**
	 * 校验验证码
	 */
	async checkImgCaptcha(id : string, code : string) {
		const getCode = await this.redisService.get(`admin:captcha:img:${id}`);
		if (isEmpty(getCode) || code.toLowerCase() !== getCode.toLowerCase()) {
			throw new ApiException(10002);
		}
		// 校验成功后移除验证码
		await this.redisService.del(`admin:captcha:img:${id}`);
	}

	/**
	 * 获取登录JWT
	 * 返回null则账号密码有误，不存在该用户
	 */

	async getLoginSign(
		username : string,
		password : string,
		ip : string,
		ua : string,
	) {
		const user : SysUser = await this.userService.findUserByUserName(username);
		if (isEmpty(user)) {
			throw new ApiException(10003);
		}

		// 密码比对
		const comparePassword = this.util.md5(`${password}${user.psalt}`)
		if (user.password !== comparePassword) {
			throw new ApiException(10003);
		}

		const perms = await this.menuService.getPerms(user.id);
		console.log('redis set perms', perms);

		const pv = Number(await this.redisService.get(`admin:passwordVersion:${user.id}`)) || 1;
		const jwtSign = this.getToken(user, pv);

		// token过期时间 24小时
		await this.redisService.set(`admin:token:${user.id}`, jwtSign.token, 60 * 60 * 24);
		await this.redisService.set(`admin:perms:${user.id}`, JSON.stringify(perms));
		await this.redisService.set(`admin:passwordVersion:${user.id}`, pv);
		await this.logService.saveLoginLog(user.id, ip, ua);
		return jwtSign;
	}

	getToken(user : SysUser, pv : number = 1) {
		const access_token = this.jwtService.sign(
			{
				uid: parseInt(user.id.toString()),
				username: user.username,
				pv,
			});
		const refresh_token = this.jwtService.sign(
			{
				uid: parseInt(user.id.toString()),
			},
			{
				expiresIn: '30d',
			}
		);
		return { token: access_token, refresh_token };
	}

	/**
	 * 清除登录状态信息
	 */
	async clearLoginStatus(userId : number) : Promise<void> {
		await this.userService.forbidden(userId);
	}

	async getUserByUid(token : string) {
		const tokenData = await this.jwtService.verifyAsync(token);
		const user = await this.userService.getAccountInfo(tokenData.uid);
		return {
			name: user.name,
			nickName: user.nickName,
			email: user.email,
			phone: user.phone,
			remark: user.remark,
			headImg: user.headImg,
		};
	}
	/**
	 * 获取权限菜单
	 */
	async getPermMenu(userId : number) {
		const menus = await this.menuService.getMenus(userId);
		const perms = await this.menuService.getPerms(userId);
		return { menus, perms };
	}

	async getRedisPasswordVersionById(id : number) : Promise<string> {
		return this.redisService.get(`admin:passwordVersion:${id}`);
	}

	async getRedisTokenById(id : number) : Promise<string> {
		return this.redisService.get(`admin:token:${id}`);
	}

	async getRedisPermsById(id : number) {
		const perms = await this.redisService.get(`admin:perms:${id}`);
		return perms
	}
}