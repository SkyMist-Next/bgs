
/home/kaloyan/work/re/WoW/artifacts/clients/7.3.5.26972/analysis-x64/Wow-64.analysis.exe:     file format pei-x86-64


Disassembly of section .text:

000000014050dea0 <.text+0x50cea0>:
   14050dea0:	48 89 5c 24 10       	mov    QWORD PTR [rsp+0x10],rbx
   14050dea5:	48 89 6c 24 18       	mov    QWORD PTR [rsp+0x18],rbp
   14050deaa:	48 89 74 24 20       	mov    QWORD PTR [rsp+0x20],rsi
   14050deaf:	57                   	push   rdi
   14050deb0:	41 56                	push   r14
   14050deb2:	41 57                	push   r15
   14050deb4:	48 83 ec 20          	sub    rsp,0x20
   14050deb8:	8b 44 24 60          	mov    eax,DWORD PTR [rsp+0x60]
   14050debc:	48 8b f1             	mov    rsi,rcx
   14050debf:	48 89 51 08          	mov    QWORD PTR [rcx+0x8],rdx
   14050dec3:	89 41 18             	mov    DWORD PTR [rcx+0x18],eax
   14050dec6:	48 8d 05 53 d0 de 00 	lea    rax,[rip+0xded053]        # 0x1412faf20
   14050decd:	4c 89 41 10          	mov    QWORD PTR [rcx+0x10],r8
   14050ded1:	48 89 01             	mov    QWORD PTR [rcx],rax
   14050ded4:	48 83 c1 20          	add    rcx,0x20
   14050ded8:	49 8b f9             	mov    rdi,r9
   14050dedb:	e8 d0 44 ff ff       	call   0x1405023b0
   14050dee0:	48 8d 4e 38          	lea    rcx,[rsi+0x38]
   14050dee4:	45 33 ff             	xor    r15d,r15d
   14050dee7:	48 8d 51 08          	lea    rdx,[rcx+0x8]
   14050deeb:	4c 8d 41 10          	lea    r8,[rcx+0x10]
   14050deef:	4c 8d 49 14          	lea    r9,[rcx+0x14]
   14050def3:	48 8d 05 16 0b de 00 	lea    rax,[rip+0xde0b16]        # 0x1412eea10
   14050defa:	44 89 79 18          	mov    DWORD PTR [rcx+0x18],r15d
   14050defe:	c7 41 1c ff ff ff ff 	mov    DWORD PTR [rcx+0x1c],0xffffffff
   14050df05:	4c 89 3a             	mov    QWORD PTR [rdx],r15
   14050df08:	45 89 38             	mov    DWORD PTR [r8],r15d
   14050df0b:	45 89 39             	mov    DWORD PTR [r9],r15d
   14050df0e:	48 89 01             	mov    QWORD PTR [rcx],rax
   14050df11:	ff 15 f9 0a de 00    	call   QWORD PTR [rip+0xde0af9]        # 0x1412eea10
   14050df17:	48 8d 4e 20          	lea    rcx,[rsi+0x20]
   14050df1b:	41 b0 01             	mov    r8b,0x1
   14050df1e:	48 8b d7             	mov    rdx,rdi
   14050df21:	e8 da 5d ff ff       	call   0x140503d00
   14050df26:	48 8d 54 24 60       	lea    rdx,[rsp+0x60]
   14050df2b:	48 8b cf             	mov    rcx,rdi
   14050df2e:	44 89 7c 24 60       	mov    DWORD PTR [rsp+0x60],r15d
   14050df33:	e8 98 3c ca ff       	call   0x1401b1bd0
   14050df38:	8b 6c 24 60          	mov    ebp,DWORD PTR [rsp+0x60]
   14050df3c:	48 8d 54 24 40       	lea    rdx,[rsp+0x40]
   14050df41:	44 8b c5             	mov    r8d,ebp
   14050df44:	48 8b cf             	mov    rcx,rdi
   14050df47:	4c 89 7c 24 40       	mov    QWORD PTR [rsp+0x40],r15
   14050df4c:	e8 3f 42 ca ff       	call   0x1401b2190
   14050df51:	83 7e 4c ff          	cmp    DWORD PTR [rsi+0x4c],0xffffffff
   14050df55:	4c 8b 74 24 40       	mov    r14,QWORD PTR [rsp+0x40]
   14050df5a:	74 17                	je     0x14050df73
   14050df5c:	48 8b 46 38          	mov    rax,QWORD PTR [rsi+0x38]
   14050df60:	4c 8d 46 48          	lea    r8,[rsi+0x48]
   14050df64:	48 8d 56 40          	lea    rdx,[rsi+0x40]
   14050df68:	4c 8d 4e 4c          	lea    r9,[rsi+0x4c]
   14050df6c:	48 8d 4e 38          	lea    rcx,[rsi+0x38]
   14050df70:	ff 50 08             	call   QWORD PTR [rax+0x8]
   14050df73:	48 8b 5c 24 48       	mov    rbx,QWORD PTR [rsp+0x48]
   14050df78:	89 6e 50             	mov    DWORD PTR [rsi+0x50],ebp
   14050df7b:	48 8b 6c 24 50       	mov    rbp,QWORD PTR [rsp+0x50]
   14050df80:	4c 89 76 40          	mov    QWORD PTR [rsi+0x40],r14
   14050df84:	44 89 7e 48          	mov    DWORD PTR [rsi+0x48],r15d
   14050df88:	c7 46 4c ff ff ff ff 	mov    DWORD PTR [rsi+0x4c],0xffffffff
   14050df8f:	44 89 7e 54          	mov    DWORD PTR [rsi+0x54],r15d
   14050df93:	48 8b c6             	mov    rax,rsi
   14050df96:	48 8b 74 24 58       	mov    rsi,QWORD PTR [rsp+0x58]
   14050df9b:	48 83 c4 20          	add    rsp,0x20
   14050df9f:	41 5f                	pop    r15
   14050dfa1:	41 5e                	pop    r14
   14050dfa3:	5f                   	pop    rdi
   14050dfa4:	c3                   	ret
   14050dfa5:	e4 e0                	in     al,0xe0
   14050dfa7:	96                   	xchg   esi,eax
   14050dfa8:	09 0f                	or     DWORD PTR [rdi],ecx
   14050dfaa:	7a a9                	jp     0x14050df55
   14050dfac:	79 f0                	jns    0x14050df9e
   14050dfae:	1f                   	(bad)
   14050dfaf:	fc                   	cld
   14050dfb0:	48 89 5c 24 08       	mov    QWORD PTR [rsp+0x8],rbx
   14050dfb5:	57                   	push   rdi
   14050dfb6:	48 83 ec 20          	sub    rsp,0x20
   14050dfba:	8b 44 24 50          	mov    eax,DWORD PTR [rsp+0x50]
   14050dfbe:	48 8b f9             	mov    rdi,rcx
   14050dfc1:	48 89 51 08          	mov    QWORD PTR [rcx+0x8],rdx
   14050dfc5:	89 41 18             	mov    DWORD PTR [rcx+0x18],eax
   14050dfc8:	48 8d 05 31 cf de 00 	lea    rax,[rip+0xdecf31]        # 0x1412faf00
   14050dfcf:	4c 89 41 10          	mov    QWORD PTR [rcx+0x10],r8
   14050dfd3:	48 89 01             	mov    QWORD PTR [rcx],rax
   14050dfd6:	48 83 c1 28          	add    rcx,0x28
   14050dfda:	49 8b d9             	mov    rbx,r9
   14050dfdd:	e8 ce 43 ff ff       	call   0x1405023b0
   14050dfe2:	48 8d 4f 40          	lea    rcx,[rdi+0x40]
   14050dfe6:	33 c0                	xor    eax,eax
   14050dfe8:	48 8d 51 08          	lea    rdx,[rcx+0x8]
   14050dfec:	4c 8d 41 10          	lea    r8,[rcx+0x10]
   14050dff0:	4c 8d 49 14          	lea    r9,[rcx+0x14]
   14050dff4:	89 41 18             	mov    DWORD PTR [rcx+0x18],eax
   14050dff7:	48 89 02             	mov    QWORD PTR [rdx],rax
   14050dffa:	41 89 00             	mov    DWORD PTR [r8],eax
   14050dffd:	41 89 01             	mov    DWORD PTR [r9],eax
   14050e000:	48 8d 05 09 0a de 00 	lea    rax,[rip+0xde0a09]        # 0x1412eea10
   14050e007:	c7 41 1c ff ff ff ff 	mov    DWORD PTR [rcx+0x1c],0xffffffff
   14050e00e:	48 89 01             	mov    QWORD PTR [rcx],rax
   14050e011:	ff 15 f9 09 de 00    	call   QWORD PTR [rip+0xde09f9]        # 0x1412eea10
   14050e017:	41 b0 01             	mov    r8b,0x1
   14050e01a:	48 8b d3             	mov    rdx,rbx
   14050e01d:	48 8b cf             	mov    rcx,rdi
   14050e020:	e8 eb 19 01 00       	call   0x14051fa10
   14050e025:	48 8b 5c 24 30       	mov    rbx,QWORD PTR [rsp+0x30]
   14050e02a:	48 8b c7             	mov    rax,rdi
   14050e02d:	48                   	rex.W
   14050e02e:	83                   	.byte 0x83
   14050e02f:	c4                   	.byte 0xc4
